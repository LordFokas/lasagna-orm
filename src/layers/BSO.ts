import { LayeredObject, DataObject, type ArrayPromise } from '../LayeredObject';
import { DLO, type SkipUUID } from './DLO';
import { type Connection } from '../DB';
import { SelectBuilder, type Chain } from '../QueryBuilder';

import { Logger } from 'loggamus';

type DLOReference = { [key:string]: typeof DLO; }
type DLOMap = {[key:string]: DLOReference }

const logger:Logger = Logger.getDefault();

export default BSO;
export class BSO extends DataObject {
	static #links:DLOMap = {};
	static #expands:DLOMap = {};

	static inflates:InflationMap = null;
	
	static get dlo() : typeof DLO {
		return (this as any)['$dlo'];
	}

	static set dlo(dlo: typeof DLO){
		(this as any)['$dlo'] = dlo;
	}

	/** Layer a BSO on top of its respective DLO. Also internally registers the classes. */
	static layer(dlo:typeof DLO, bso:typeof BSO){
		dlo.bso = bso;
		bso.dlo = dlo;
		DataObject.$put(dlo);
		DataObject.$put(bso);
	}

	/** Create link-expansion relationships between entities. Works with DLOs. */
	static link(childDLO:typeof DLO, parentDLO?:typeof DLO){
		if(!parentDLO) return {
			to: (...ps:(typeof DLO)[]):any => ps.map(p => BSO.link(childDLO, p))
		};

		if(!BSO.#links[childDLO.name])
			BSO.#links[childDLO.name] = {};
		const links = BSO.#links[childDLO.name];
		links[parentDLO.linkname] = parentDLO;

		if(!BSO.#expands[parentDLO.name])
			BSO.#expands[parentDLO.name] = {};
		const expands = BSO.#expands[parentDLO.name];
		expands[childDLO.expandname] = childDLO;
	}

	/** Apply an async function to every link of this BSO */
	static async forEachLink(bso:BSO, fn:(x:typeof DLO)=>Promise<any>) : Promise<void> {
		const dlo:string = bso.dlo.name;
		if(!BSO.#links[dlo]) return;
		const links = Object.values(BSO.#links[dlo]);
		for(const link of links) await fn(link);
	}

	/** Apply an async function to every expansion of this BSO */
	static async forEachExpand(bso:BSO, fn:(x:typeof DLO)=>Promise<any>) : Promise<void> {
		const dlo:string = bso.dlo.name;
		if(!BSO.#expands[dlo]) return;
		const expands = Object.values(BSO.#expands[dlo]);
		for(const expand of expands) await fn(expand);
	}

	// ########################################################################
	// WRITE

	/** Validate the contents of a BSO */
	static #validateStructure(operation:string, bso:BSO) : void {}

	/** Insert a group of similar BSOs in bulk */
	static async bulkInsert(db:Connection, bsos:BSO[]){
		logger.warn('Initiating unoptimized BSO bulk insert');
		for(const bso of bsos){
			await bso.insert(db);
		}
	}

	/** Create a BSO in the database, along with all dependencies and relationships. */
	static async create(db:Connection, bso:BSO, skip:SkipUUID) : Promise<void> {
		BSO.#validateStructure('create', bso);
		await db.DANGEROUSLY("BEGIN TRANSACTION");
		try{
			await BSO.#insertLinks(db, bso);
			await BSO.#insertDLO(db, bso, skip);
			await BSO.#insertExpands(db, bso);
			await db.DANGEROUSLY("COMMIT");
		}catch(error){
			logger.error(error);
			await db.DANGEROUSLY("ROLLBACK");
			throw error;
		}
	}

	/** Insert all of a BSO's links (parents). These are required before the BSO is inserted */
	static async #insertLinks(db:Connection, bso:BSO) : Promise<void> {
		await BSO.forEachLink(bso, async lnk => {
			const dlo = bso[lnk.linkname] as DLO;
			if(!dlo) return;
			dlo.insert(db);
			bso[`uuid_${lnk.linkname}`] = dlo.uuid;
		});
	}

	/** Insert this BSO as a flat DLO in the database. This is needed before expands so that it gets a UUID */
	static async #insertDLO(db:Connection, bso:BSO, skip:SkipUUID) : Promise<void> {
		const dlo = bso.dlo();
		await dlo.insert(db, skip);
		bso.uuid = dlo.uuid;
	}

	/** Insert this BSO's expands (children). This has to be the last insertion step */
	static async #insertExpands(db:Connection, bso:BSO) : Promise<void> {
		await BSO.forEachExpand(bso, async exp => {
			const dlos = bso[exp.expandname] as DLO[];
			if(!dlos || dlos.length < 1) return;
			const link = this.dlo.linkname;
			for(const dlo of dlos){
				dlo[`uuid_${link}`] = bso.uuid;
			}
			await dlos.insertAll(db);
		});
	}

	// ########################################################################
	// READ

	/** Load all BSOs from one table and inflate them */
	static async all<T extends BSO>(db:Connection, inflate:string = 'all') // @ts-ignore
	:ArrayPromise<T> {
		return await this.inflate(db, inflate) as T[];
	}

	/** Load one BSO by UUID and inflate it */
	static async uuid<T extends BSO>(db:Connection, uuid:string, inflate:string = 'uuid') // @ts-ignore
	:ArrayPromise<T> {
		return await this.inflate(db, inflate, uuid) as T[];
	}

	/** Query and inflate BSOs. This entails recursion and complexity */
	static async inflate(db:Connection|false, inflate:string, ...params:(boolean|string|number)[]) : Promise<BSO[] | SelectBuilder> {
		const dloClass = this.dlo as typeof DLO & DLOFunctionHacks;
		const { self, links, expands } = (this.inflates as InflationMapGeneric<typeof DLO & DLOFunctionHacks>)[inflate];

		// load self and links' main bodies with a single query
		const query = await dloClass[self.exec](false, ...params, ...self.params);
		for(const link of links){
			query.join(await link.type[link.exec](false, ...link.params), link.reverse);
		}
		if(db === false) return query;
		const results = await query.execute(db);
		const chains = query.chains();
		if(results.rows.length == 0) return [];

		// recursively construct self and links
		const bsos:BSO[] = await Promise.all(results.rows.map(async (row:object) => {
			const bso = new this.dlo(false, row).bso();
			for(const link of links){
				if(link.type.prototype instanceof BSO){
					const bsoChildType = (link.type as any as typeof BSO);
					const bsoChild = new bsoChildType.dlo(false, row).bso();
					chains.filter((c:Chain) => c.parent == bsoChildType.dlo).map(c => {
						BSO.recursiveLink(bsoChild, row, c.child, chains);
					});
					// @ts-ignore
					await bsoChild.finishInflation(db, ...link.params);
					bso.useLink(bsoChild);
				}else if(link.type.prototype instanceof DLO){
					bso.useLink(new link.type(false, row));
				}else{
					throw new Error('Unsupported linkage type');
				}
			}
			return bso;
		}));

		// bsos indexed by uuid
		const uuids = bsos.map(bso => bso.uuid);
		const index = bsos.reduce((map:{[key:string]:BSO}, bso) => {
			map[bso.uuid] = bso;
			return map;
		}, {});

		// load expands
		for(const expand of expands){
			if(expand.noBulk){
				for(const bso of bsos){
					const type = expand.type;
					const dlos = await type[expand.exec](db, ...expand.params, [
						{col: `uuid_${dloClass.linkname}`, var: bso.uuid}
					]);
					const exp = type.expandname || (type as any as typeof BSO).dlo.expandname;
					bso[exp] = dlos;
				}
			}else{
				const type = expand.type;
				const link = `uuid_${dloClass.linkname}`;
				const dlos = await type[expand.exec](db, ...expand.params, [{col: link, in: uuids}]);
				dlos.map(dlo => index[(dlo[link] as string)].useExpand(dlo));
			}
		}

		return bsos;
	}

	/** ??? */
	static recursiveLink(bso:BSO, row:object, type:typeof DLO, chains?:Chain[]) : void {
		if(type.prototype instanceof BSO){
			const bsoChild = new (type as any as typeof BSO).dlo(false, row).bso();
			chains.filter(c => c.parent == type).map(c => {
				BSO.recursiveLink(bsoChild, row, c.child);
			});
			bso.useLink(bsoChild);
		}else if(type.prototype instanceof DLO){
			bso.useLink(new type(false, row));
		}else{
			throw new Error('Unsupported linkage type');
		}
	}

	/** ??? */
	async finishInflation(db:Connection, inflate:string, ...params:any[]) : Promise<void> {
		const { self, links, expands } = (this.$('inflates') as InflationMapGeneric<typeof DLO & DLOFunctionHacks>)[inflate];
		const linkname = this.$('dlo').linkname;
		for(const expand of expands){
			const type = expand.type;
			const dlos = await type[expand.exec](db, ...expand.params, [
				{col: `uuid_${linkname}`, var: this.uuid}
			]);
			const exp = type.expandname || (type as any as typeof BSO).dlo.expandname;
			this[exp] = dlos;
		}

		for(const link of links){
			if(link.type.prototype instanceof BSO){
				const bsoChild = this[(link.type as any as typeof BSO).dlo.linkname] as BSO;
				// @ts-ignore
				if(bsoChild) await bsoChild.finishInflation(db, ...link.params);
			}
		}
	}

	// ########################################################################
	// INSTANCE
	constructor(dlo:DLO){
		super();
		this.inherit(dlo);
	}

	/** Inherit the data from a base DLO */
	inherit(dlo:DLO) : void {
		Object.assign(this, dlo);
	}

	/** Inserts itself into the database */
	async insert(db:Connection, skip:SkipUUID = false) : Promise<void> {
		const bso = this.constructor as typeof BSO;
		return await bso.create(db, this, skip);
	}

	dlo() : DLO {
		const dlo:{[key:string]:any} = {};
		for(const [k, v] of Object.entries(this)){
			if(Array.isArray(v) || v instanceof LayeredObject) continue;
			dlo[k] = v;
		}
		return new (this.$('dlo'))(dlo);
	}

	bso() : this {
		return this;
	}

	/** Use this entity as a link (instance of parent entity) */
	useLink(dlo:DLO|BSO) : void{
		const field = (dlo instanceof DLO) ? dlo.$('linkname') : dlo.$('dlo').linkname;
		this[field] = dlo;
	}

	/** Use this entity as an expand (instance of child entity) */
	useExpand(dlo:DLO|BSO) : void {
		const field = (dlo instanceof DLO) ? dlo.$('expandname') : dlo.$('dlo').expandname;
		if(this[field]) (this[field] as (DLO|BSO)[]).push(dlo);
		else this[field] = [dlo];
	}
}

interface DLOFunctionHacks { [key:string]: ScaffoldingFunction&LoadingFunction; }
type ScaffoldingFunction = (c:false, ...$:any[]) => Promise<SelectBuilder>;
type LoadingFunction = (c:Connection, ...$:any[]) => Promise<DLO[]>;

export type InflationMap = InflationMapGeneric<typeof DLO | typeof BSO>;
export interface InflationMapGeneric<T extends typeof DLO | typeof BSO>{
	[key:string]: {
		self: LoadParams
		links: LoadParamsLink<T>[]
		expands: LoadParamsExpand<T>[]
	}
}

export interface LoadParams { 
	exec: string
	params: string[]
}

export interface LoadParamsLink<T extends typeof DLO | typeof BSO> extends LoadParams { 
	type: T
	reverse: boolean
}

export interface LoadParamsExpand<T extends typeof DLO | typeof BSO> extends LoadParams { 
	type: T
	noBulk: boolean
}


LayeredObject.BSO = BSO;