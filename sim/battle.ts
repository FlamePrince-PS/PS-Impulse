/**
 * Simulator Battle
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * @license MIT
 */
import Dex = require('./dex');
global.toId = Dex.getId;
import Server = require('./Server.js').Server;
import * as Data from './dex-data';
import {Pokemon} from './pokemon';
import {PRNG, PRNGSeed} from './prng';
import {Side} from './side';

/** A Pokemon that has fainted. */
interface FaintedPokemon {
	target: Pokemon;
	source: Pokemon | null;
	effect: Effect | null;
}

interface PlayerOptions {
	name?: string;
	avatar?: string;
	team?: PokemonSet[] | string | null;
}

interface BattleOptions {
	formatid: string; // Format ID
	send?: (type: string, data: string | string[]) => void; // Output callback
	prng?: PRNG; // PRNG override (you usually don't need this, just pass a seed)
	seed?: PRNGSeed; // PRNG seed
	rated?: boolean | string; // Rated string
	p1?: PlayerOptions; // Player 1 data
	p2?: PlayerOptions; // Player 2 data
	debug?: boolean; // show debug mode option
}

export class Battle extends Dex.ModdedDex {
	id: string;
	zMoveTable: {[k: string]: string};
	log: string[];
	inputLog: string[];
	sentLogPos: number;
	sentEnd: boolean;
	sides: Side[];
	rated: boolean | string;
	weatherData: AnyObject;
	terrainData: AnyObject;
	pseudoWeather: AnyObject;
	format: string;
	formatid: string;
	cachedFormat: Format;
	debugMode: boolean;
	formatData: AnyObject;
	effect: Effect;
	effectData: AnyObject;
	event: AnyObject;
	itemData: AnyObject;
	gameType: GameType;
	reportExactHP: boolean;
	queue: Actions["Action"][];
	faintQueue: FaintedPokemon[];
	messageLog: string[];
	send: (type: string, data: string | string[]) => void;
	turn: number;
	p1: Side;
	p2: Side;
	lastUpdate: number;
	weather: string;
	terrain: string;
	ended: boolean;
	started: boolean;
	active: boolean;
	eventDepth: number;
	lastMove: Move | null;
	activeMove: ActiveMove | null;
	activePokemon: Pokemon | null;
	activeTarget: Pokemon | null;
	midTurn: boolean;
	currentRequest: string;
	lastMoveLine: number;
	reportPercentages: boolean;
	supportCancel: boolean;
	events: AnyObject | null;
	lastDamage: number;
	abilityOrder: number;
	NOT_FAILURE: '';
	prng: PRNG;
	prngSeed: PRNGSeed;
	teamGenerator: ReturnType<typeof Dex.getTeamGenerator> | null;
	winner?: string;
	firstStaleWarned?: boolean;
	staleWarned?: boolean;
	activeTurns?: number;
	hints: Set<string>;

	constructor(options: BattleOptions) {
		let format = Dex.getFormat(options.formatid, true);
		super(format.mod);
		this.zMoveTable = {};
		Object.assign(this, this.data.Scripts);
		this.id = '';
		this.log = [];
		this.inputLog = [];
		this.sentLogPos = 0;
		this.sentEnd = false;
		// @ts-ignore
		this.sides = [null, null];
		// @ts-ignore
		this.rated = options.rated;
		this.weatherData = {id: ''};
		this.terrainData = {id: ''};
		this.pseudoWeather = {};
		this.format = format.id;
		this.formatid = options.formatid;
		this.cachedFormat = format;
		this.debugMode = format.debug || !!options.debug;
		this.formatData = {id: format.id};
		// tslint:disable-next-line:no-object-literal-type-assertion
		this.effect = {id: ''} as Effect;
		this.effectData = {id: ''};
		this.event = {id: ''};
		this.itemData = {id: ''};
		this.gameType = (format.gameType || 'singles');
		this.reportExactHP = !!format.debug;
		this.queue = [];
		this.faintQueue = [];
		this.messageLog = [];
		this.send = options.send || (() => {});
		this.turn = 0;
		// @ts-ignore
		this.p1 = null;
		// @ts-ignore
		this.p2 = null;
		this.lastUpdate = 0;
		this.weather = '';
		this.terrain = '';
		this.ended = false;
		this.started = false;
		this.active = false;
		this.eventDepth = 0;
		this.lastMove = null;
		this.activeMove = null;
		this.activePokemon = null;
		this.activeTarget = null;
		this.midTurn = false;
		this.currentRequest = '';
		this.lastMoveLine = -1;
		this.reportPercentages = false;
		this.supportCancel = false;
		this.events = null;
		this.lastDamage = 0;
		this.abilityOrder = 0;
		this.NOT_FAILURE = '';
		this.prng = options.prng || new PRNG(options.seed || undefined);
		this.prngSeed = this.prng.startingSeed.slice() as PRNGSeed;
		this.teamGenerator = null;
		// bound function for faster speedSort
		// (so speedSort doesn't need to bind before use)
		this.comparePriority = this.comparePriority.bind(this);
		this.hints = new Set();

		const inputOptions: {formatid: string, seed: PRNGSeed, rated?: string | true} = {formatid: options.formatid, seed: this.prng.seed};
		if (this.rated) inputOptions.rated = this.rated;
		if (global.__version) {
			this.inputLog.push(`>version ${global.__version}`);
		}
		this.inputLog.push(`>start ` + JSON.stringify(inputOptions));

		for (const rule of this.getRuleTable(format).keys()) {
			if (rule.startsWith('+') || rule.startsWith('-') || rule.startsWith('!')) continue;
			let subFormat = this.getFormat(rule);
			if (subFormat.exists) {
				let hasEventHandler = Object.keys(subFormat).some(val =>
					val.startsWith('on') && !['onBegin', 'onValidateTeam', 'onChangeSet', 'onValidateSet'].includes(val)
				);
				if (hasEventHandler) this.addPseudoWeather(rule);
			}
		}
		if (options.p1) {
			this.setPlayer('p1', options.p1);
		}
		if (options.p2) {
			this.setPlayer('p2', options.p2);
		}
	}

	static logReplay(data: string, isReplay: boolean | Side) {
		if (isReplay === true) return data;
		return '';
	}

	toString() {
		return 'Battle: ' + this.format;
	}

	random(m?: number, n?: number) {
		return this.prng.next(m, n);
	}

	randomChance(numerator: number, denominator: number) {
		return this.prng.randomChance(numerator, denominator);
	}

	sample<T>(items: ReadonlyArray<T>): T {
		return this.prng.sample(items);
	}

	resetRNG() {
		this.prng = new PRNG(this.prng.startingSeed);
	}

	setWeather(status: string | PureEffect, source: Pokemon | 'debug' | null = null, sourceEffect: Effect | null = null) {
		status = this.getEffect(status);
		if (!sourceEffect && this.effect) sourceEffect = this.effect;
		if (!source && this.event && this.event.target) source = this.event.target;
		if (source === 'debug') source = this.p1.active[0];

		if (this.weather === status.id) {
			if (sourceEffect && sourceEffect.effectType === 'Ability') {
				if (this.gen > 5 || this.weatherData.duration === 0) {
					return false;
				}
			} else if (this.gen > 2 || status.id === 'sandstorm') {
				return false;
			}
		}
		if (source) {
			let result = this.runEvent('SetWeather', source, source, status);
			if (!result) {
				if (result === false) {
					if (sourceEffect && sourceEffect.weather) {
						this.add('-fail', source, sourceEffect, '[from] ' + this.weather);
					} else if (sourceEffect && sourceEffect.effectType === 'Ability') {
						this.add('-ability', source, sourceEffect, '[from] ' + this.weather, '[fail]');
					}
				}
				return null;
			}
		}
		let prevWeather = this.weather;
		let prevWeatherData = this.weatherData;
		this.weather = status.id;
		this.weatherData = {id: status.id};
		if (source) {
			this.weatherData.source = source;
			this.weatherData.sourcePosition = source.position;
		}
		if (status.duration) {
			this.weatherData.duration = status.duration;
		}
		if (status.durationCallback) {
			if (!source) throw new Error(`setting weather without a source`);
			this.weatherData.duration = status.durationCallback.call(this, source, source, sourceEffect);
		}
		if (!this.singleEvent('Start', status, this.weatherData, this, source, sourceEffect)) {
			this.weather = prevWeather;
			this.weatherData = prevWeatherData;
			return false;
		}
		return true;
	}

	clearWeather() {
		if (!this.weather) {
			return false;
		}
		let oldstatus = this.getWeather();
		this.singleEvent('End', oldstatus, this.weatherData, this);
		this.weather = '';
		this.weatherData = {id: ''};
		return true;
	}

	effectiveWeather() {
		if (this.suppressingWeather()) return '';
		return this.weather;
	}

	isWeather(weather: string | string[]) {
		let ourWeather = this.effectiveWeather();
		if (!Array.isArray(weather)) {
			return ourWeather === toId(weather);
		}
		return weather.map(toId).includes(ourWeather);
	}

	getWeather() {
		return this.getEffect(this.weather);
	}

	setTerrain(status: string | Effect, source: Pokemon | 'debug' | null = null, sourceEffect: Effect | null = null) {
		status = this.getEffect(status);
		if (!sourceEffect && this.effect) sourceEffect = this.effect;
		if (!source && this.event && this.event.target) source = this.event.target;
		if (source === 'debug') source = this.p1.active[0];
		if (!source) throw new Error(`setting terrain without a source`);

		if (this.terrain === status.id) return false;
		let prevTerrain = this.terrain;
		let prevTerrainData = this.terrainData;
		this.terrain = status.id;
		this.terrainData = {
			id: status.id,
			source,
			sourcePosition: source.position,
			duration: status.duration,
		};
		if (status.durationCallback) {
			this.terrainData.duration = status.durationCallback.call(this, source, source, sourceEffect);
		}
		if (!this.singleEvent('Start', status, this.terrainData, this, source, sourceEffect)) {
			this.terrain = prevTerrain;
			this.terrainData = prevTerrainData;
			return false;
		}
		this.runEvent('TerrainStart', source, source, status);
		return true;
	}

	clearTerrain() {
		if (!this.terrain) return false;
		let oldstatus = this.getTerrain();
		this.singleEvent('End', oldstatus, this.terrainData, this);
		this.terrain = '';
		this.terrainData = {id: ''};
		return true;
	}

	effectiveTerrain(target?: Pokemon | Side | Battle) {
		if (this.event) {
			if (!target) target = this.event.target;
		}
		if (!this.runEvent('TryTerrain', target)) return '';
		return this.terrain;
	}

	isTerrain(terrain: string | string[], target?: Pokemon | Side | Battle) {
		let ourTerrain = this.effectiveTerrain(target);
		if (!Array.isArray(terrain)) {
			return ourTerrain === toId(terrain);
		}
		return terrain.map(toId).includes(ourTerrain);
	}

	getTerrain() {
		return this.getEffect(this.terrain);
	}

	// @ts-ignore
	getFormat(format?: string) {
		if (!format) return this.cachedFormat;
		return super.getFormat(format, true);
	}

	addPseudoWeather(status: string | PureEffect, source: Pokemon | 'debug' | null = null, sourceEffect: Effect | null = null): boolean {
		if (!source && this.event && this.event.target) source = this.event.target;
		if (source === 'debug') source = this.p1.active[0];
		status = this.getEffect(status);

		let effectData = this.pseudoWeather[status.id];
		if (effectData) {
			if (!status.onRestart) return false;
			return this.singleEvent('Restart', status, effectData, this, source, sourceEffect);
		}
		effectData = this.pseudoWeather[status.id] = {
			id: status.id,
			source,
			sourcePosition: source && source.position,
			duration: status.duration,
		};
		if (status.durationCallback) {
			if (!source) throw new Error(`setting fieldcond without a source`);
			effectData.duration = status.durationCallback.call(this, source, source, sourceEffect);
		}
		if (!this.singleEvent('Start', status, effectData, this, source, sourceEffect)) {
			delete this.pseudoWeather[status.id];
			return false;
		}
		return true;
	}

	getPseudoWeather(status: string | Effect) {
		status = this.getEffect(status);
		if (!this.pseudoWeather[status.id]) return null;
		return status;
	}

	removePseudoWeather(status: string | Effect) {
		status = this.getEffect(status);
		let effectData = this.pseudoWeather[status.id];
		if (!effectData) return false;
		this.singleEvent('End', status, effectData, this);
		delete this.pseudoWeather[status.id];
		return true;
	}

	suppressingAttackEvents() {
		return this.activePokemon && this.activePokemon.isActive && this.activeMove && this.activeMove.ignoreAbility;
	}

	suppressingWeather() {
		for (const side of this.sides) {
			for (const pokemon of side.active) {
				if (pokemon && !pokemon.ignoringAbility() && pokemon.getAbility().suppressWeather) {
					return true;
				}
			}
		}
		return false;
	}

	setActiveMove(move?: ActiveMove | null, pokemon?: Pokemon | null, target?: Pokemon | null) {
		if (!move) move = null;
		if (!pokemon) pokemon = null;
		if (!target) target = pokemon;
		this.activeMove = move;
		this.activePokemon = pokemon;
		this.activeTarget = target;
	}

	clearActiveMove(failed?: boolean) {
		if (this.activeMove) {
			if (!failed) {
				this.lastMove = this.activeMove;
			}
			this.activeMove = null;
			this.activePokemon = null;
			this.activeTarget = null;
		}
	}

	updateSpeed() {
		let actives = this.p1.active;
		for (const active of actives) {
			if (active) active.updateSpeed();
		}
		actives = this.p2.active;
		for (const active of actives) {
			if (active) active.updateSpeed();
		}
	}

	/**
	 * Truncate a number into an unsigned 32-bit integer, for
	 * compatibility with the cartridge games' math systems.
	 */
	trunc(num: number, bits: number = 0) {
		if (bits) return (num >>> 0) % (2 ** bits);
		return num >>> 0;
	}

	comparePriority(a: AnyObject, b: AnyObject) {
		return -((b.order || 4294967296) - (a.order || 4294967296)) ||
			((b.priority || 0) - (a.priority || 0)) ||
			((b.speed || 0) - (a.speed || 0)) ||
			-((b.subOrder || 0) - (a.subOrder || 0)) ||
			0;
	}

	static compareRedirectOrder(a: AnyObject, b: AnyObject) {
		return ((b.priority || 0) - (a.priority || 0)) ||
			((b.speed || 0) - (a.speed || 0)) ||
			-(b.thing.abilityOrder - a.thing.abilityOrder) ||
			0;
	}

	/**
	 * Sort a list, resolving speed ties the way the games do.
	 */
	speedSort<T>(list: T[], comparator: (a: T, b: T) => number = this.comparePriority) {
		if (list.length < 2) return;
		let sorted = 0;
		while (sorted + 1 < list.length) {
			let nextIndexes = [sorted];
			// grab list of next indexes
			for (let i = sorted + 1; i < list.length; i++) {
				let delta = comparator(list[nextIndexes[0]], list[i]);
				if (delta < 0) continue;
				if (delta > 0) nextIndexes = [i];
				if (delta === 0) nextIndexes.push(i);
			}
			// put list of next indexes where they belong
			let nextCount = nextIndexes.length;
			for (let i = 0; i < nextCount; i++) {
				let index = nextIndexes[i];
				while (index > sorted + i) {
					[list[index], list[index - 1]] = [list[index - 1], list[index]];
					index--;
				}
			}
			if (nextCount > 1) this.prng.shuffle(list, sorted, sorted + nextCount);
			sorted += nextCount;
		}
	}

	eachEvent(eventid: string, effect?: Effect, relayVar?: boolean) {
		let actives = [];
		if (!effect && this.effect) effect = this.effect;
		for (const side of this.sides) {
			for (const pokemon of side.active) {
				if (pokemon) actives.push(pokemon);
			}
		}
		this.speedSort(actives, (a, b) =>
			b.speed - a.speed
		);
		for (const pokemon of actives) {
			this.runEvent(eventid, pokemon, null, effect, relayVar);
		}
		if (eventid === 'Weather' && this.gen >= 7) {
			// TODO: further research when updates happen
			this.eachEvent('Update');
		}
	}

	residualEvent(eventid: string, relayVar?: any) {
		let callbackName = `on${eventid}`;
		let handlers = this.findBattleEventHandlers(callbackName, 'duration');
		for (const side of this.sides) {
			handlers = handlers.concat(this.findSideEventHandlers(side, callbackName, 'duration'));
			for (const active of side.active) {
				if (!active) continue;
				handlers = handlers.concat(this.findPokemonEventHandlers(active, callbackName, 'duration'));
			}
		}
		this.speedSort(handlers);
		while (handlers.length) {
			let handler = handlers[0];
			handlers.shift();
			let status = handler.status;
			if (handler.thing.fainted) continue;
			if (handler.statusData && handler.statusData.duration) {
				handler.statusData.duration--;
				if (!handler.statusData.duration) {
					handler.end.call(handler.thing, status.id);
					continue;
				}
			}
			this.singleEvent(eventid, status, handler.statusData, handler.thing, relayVar);
			this.faintMessages();
			if (this.ended) return;
		}
	}

	/**
	 * The entire event system revolves around this function
	 * (and its helper functions, getRelevant * )
	 */
	singleEvent(
		eventid: string, effect: Effect, effectData: AnyObject | null,
		target: string | Pokemon | Side | Battle | null, source?: string | Pokemon | Effect | false | null,
		sourceEffect?: Effect | string | null, relayVar?: any) {
		if (this.eventDepth >= 8) {
			// oh fuck
			this.add('message', 'STACK LIMIT EXCEEDED');
			this.add('message', 'PLEASE REPORT IN BUG THREAD');
			this.add('message', 'Event: ' + eventid);
			this.add('message', 'Parent event: ' + this.event.id);
			throw new Error("Stack overflow");
		}
		// this.add('Event: ' + eventid + ' (depth ' + this.eventDepth + ')');
		let hasRelayVar = true;
		if (relayVar === undefined) {
			relayVar = true;
			hasRelayVar = false;
		}

		// @ts-ignore
		if (effect.effectType === 'Status' && target.status !== effect.id) {
			// it's changed; call it off
			return relayVar;
		}
		if (eventid !== 'Start' && eventid !== 'TakeItem' && eventid !== 'Primal' &&
			effect.effectType === 'Item' && (target instanceof Pokemon) && target.ignoringItem()) {
			this.debug(eventid + ' handler suppressed by Embargo, Klutz or Magic Room');
			return relayVar;
		}
		if (eventid !== 'End' && effect.effectType === 'Ability' && (target instanceof Pokemon) && target.ignoringAbility()) {
			this.debug(eventid + ' handler suppressed by Gastro Acid');
			return relayVar;
		}
		if (effect.effectType === 'Weather' && eventid !== 'Start' && eventid !== 'Residual' &&
			eventid !== 'End' && this.suppressingWeather()) {
			this.debug(eventid + ' handler suppressed by Air Lock');
			return relayVar;
		}

		// @ts-ignore
		let callback = effect['on' + eventid];

		if (callback === undefined) return relayVar;
		let parentEffect = this.effect;
		let parentEffectData = this.effectData;
		let parentEvent = this.event;
		this.effect = effect;
		this.effectData = effectData || {};
		this.event = {id: eventid, target, source, effect: sourceEffect};
		this.eventDepth++;
		let args = [target, source, sourceEffect];
		if (hasRelayVar) args.unshift(relayVar);
		let returnVal;
		if (typeof callback === 'function') {
			returnVal = callback.apply(this, args);
		} else {
			returnVal = callback;
		}
		this.eventDepth--;
		this.effect = parentEffect;
		this.effectData = parentEffectData;
		this.event = parentEvent;
		if (returnVal === undefined) return relayVar;
		return returnVal;
	}

	/**
	 * runEvent is the core of Pokemon Showdown's event system.
	 *
	 * Basic usage
	 * ===========
	 *
	 *   this.runEvent('Blah')
	 * will trigger any onBlah global event handlers.
	 *
	 *   this.runEvent('Blah', target)
	 * will additionally trigger any onBlah handlers on the target, onAllyBlah
	 * handlers on any active pokemon on the target's team, and onFoeBlah
	 * handlers on any active pokemon on the target's foe's team
	 *
	 *   this.runEvent('Blah', target, source)
	 * will additionally trigger any onSourceBlah handlers on the source
	 *
	 *   this.runEvent('Blah', target, source, effect)
	 * will additionally pass the effect onto all event handlers triggered
	 *
	 *   this.runEvent('Blah', target, source, effect, relayVar)
	 * will additionally pass the relayVar as the first argument along all event
	 * handlers
	 *
	 * You may leave any of these null. For instance, if you have a relayVar but
	 * no source or effect:
	 *   this.runEvent('Damage', target, null, null, 50)
	 *
	 * Event handlers
	 * ==============
	 *
	 * Items, abilities, statuses, and other effects like SR, confusion, weather,
	 * or Trick Room can have event handlers. Event handlers are functions that
	 * can modify what happens during an event.
	 *
	 * event handlers are passed:
	 *   function (target, source, effect)
	 * although some of these can be blank.
	 *
	 * certain events have a relay variable, in which case they're passed:
	 *   function (relayVar, target, source, effect)
	 *
	 * Relay variables are variables that give additional information about the
	 * event. For instance, the damage event has a relayVar which is the amount
	 * of damage dealt.
	 *
	 * If a relay variable isn't passed to runEvent, there will still be a secret
	 * relayVar defaulting to `true`, but it won't get passed to any event
	 * handlers.
	 *
	 * After an event handler is run, its return value helps determine what
	 * happens next:
	 * 1. If the return value isn't `undefined`, relayVar is set to the return
	 *    value
	 * 2. If relayVar is falsy, no more event handlers are run
	 * 3. Otherwise, if there are more event handlers, the next one is run and
	 *    we go back to step 1.
	 * 4. Once all event handlers are run (or one of them results in a falsy
	 *    relayVar), relayVar is returned by runEvent
	 *
	 * As a shortcut, an event handler that isn't a function will be interpreted
	 * as a function that returns that value.
	 *
	 * You can have return values mean whatever you like, but in general, we
	 * follow the convention that returning `false` or `null` means
	 * stopping or interrupting the event.
	 *
	 * For instance, returning `false` from a TrySetStatus handler means that
	 * the pokemon doesn't get statused.
	 *
	 * If a failed event usually results in a message like "But it failed!"
	 * or "It had no effect!", returning `null` will suppress that message and
	 * returning `false` will display it. Returning `null` is useful if your
	 * event handler already gave its own custom failure message.
	 *
	 * Returning `undefined` means "don't change anything" or "keep going".
	 * A function that does nothing but return `undefined` is the equivalent
	 * of not having an event handler at all.
	 *
	 * Returning a value means that that value is the new `relayVar`. For
	 * instance, if a Damage event handler returns 50, the damage event
	 * will deal 50 damage instead of whatever it was going to deal before.
	 *
	 * Useful values
	 * =============
	 *
	 * In addition to all the methods and attributes of Dex, Battle, and
	 * Scripts, event handlers have some additional values they can access:
	 *
	 * this.effect:
	 *   the Effect having the event handler
	 * this.effectData:
	 *   the data store associated with the above Effect. This is a plain Object
	 *   and you can use it to store data for later event handlers.
	 * this.effectData.target:
	 *   the Pokemon, Side, or Battle that the event handler's effect was
	 *   attached to.
	 * this.event.id:
	 *   the event ID
	 * this.event.target, this.event.source, this.event.effect:
	 *   the target, source, and effect of the event. These are the same
	 *   variables that are passed as arguments to the event handler, but
	 *   they're useful for functions called by the event handler.
	 */
	runEvent(
		eventid: string, target?: Pokemon | Side | Battle | null, source?: string | Pokemon | false | null,
		effect?: Effect | null, relayVar?: any, onEffect?: boolean, fastExit?: boolean) {
		// if (Battle.eventCounter) {
		// 	if (!Battle.eventCounter[eventid]) Battle.eventCounter[eventid] = 0;
		// 	Battle.eventCounter[eventid]++;
		// }
		if (this.eventDepth >= 8) {
			// oh fuck
			this.add('message', 'STACK LIMIT EXCEEDED');
			this.add('message', 'PLEASE REPORT IN BUG THREAD');
			this.add('message', 'Event: ' + eventid);
			this.add('message', 'Parent event: ' + this.event.id);
			throw new Error("Stack overflow");
		}
		if (!target) target = this;
		let effectSource = null;
		if (source instanceof Pokemon) effectSource = source;
		let handlers = this.findEventHandlers(target, eventid, effectSource);
		if (fastExit) {
			handlers.sort(Battle.compareRedirectOrder);
		} else {
			this.speedSort(handlers);
		}
		let hasRelayVar = true;
		let args = [target, source, effect];
		// console.log('Event: ' + eventid + ' (depth ' + this.eventDepth + ') t:' + target.id + ' s:' + (!source || source.id) + ' e:' + effect.id);
		if (relayVar === undefined || relayVar === null) {
			relayVar = true;
			hasRelayVar = false;
		} else {
			args.unshift(relayVar);
		}

		let parentEvent = this.event;
		this.event = {id: eventid, target, source, effect, modifier: 1};
		this.eventDepth++;

		if (onEffect) {
			if (!effect) throw new Error("onEffect passed without an effect");
			// @ts-ignore
			let callback = effect[`on${eventid}`];
			if (callback !== undefined) {
				handlers.unshift({status: effect, callback, statusData: {}, end: null, thing: target});
			}
		}
		for (const handler of handlers) {
			let status = handler.status;
			let thing = handler.thing;
			// this.debug('match ' + eventid + ': ' + status.id + ' ' + status.effectType);
			if (status.effectType === 'Status' && thing.status !== status.id) {
				// it's changed; call it off
				continue;
			}
			if (status.effectType === 'Ability' && !status.isUnbreakable && this.suppressingAttackEvents() && this.activePokemon !== thing) {
				// ignore attacking events
				let AttackingEvents = {
					BeforeMove: 1,
					BasePower: 1,
					Immunity: 1,
					RedirectTarget: 1,
					Heal: 1,
					SetStatus: 1,
					CriticalHit: 1,
					ModifyAtk: 1, ModifyDef: 1, ModifySpA: 1, ModifySpD: 1, ModifySpe: 1, ModifyAccuracy: 1,
					ModifyBoost: 1,
					ModifyDamage: 1,
					ModifySecondaries: 1,
					ModifyWeight: 1,
					TryAddVolatile: 1,
					TryHit: 1,
					TryHitSide: 1,
					TryMove: 1,
					Boost: 1,
					DragOut: 1,
					Effectiveness: 1,
				};
				if (eventid in AttackingEvents) {
					this.debug(eventid + ' handler suppressed by Mold Breaker');
					continue;
				} else if (eventid === 'Damage' && effect && effect.effectType === 'Move') {
					this.debug(eventid + ' handler suppressed by Mold Breaker');
					continue;
				}
			}
			if (eventid !== 'Start' && eventid !== 'SwitchIn' && eventid !== 'TakeItem' &&
				status.effectType === 'Item' && (thing instanceof Pokemon) && thing.ignoringItem()) {
				if (eventid !== 'Update') {
					this.debug(eventid + ' handler suppressed by Embargo, Klutz or Magic Room');
				}
				continue;
			} else if (eventid !== 'End' && status.effectType === 'Ability' && (thing instanceof Pokemon) && thing.ignoringAbility()) {
				if (eventid !== 'Update') {
					this.debug(eventid + ' handler suppressed by Gastro Acid');
				}
				continue;
			}
			if ((status.effectType === 'Weather' || eventid === 'Weather') &&
				eventid !== 'Residual' && eventid !== 'End' && this.suppressingWeather()) {
				this.debug(eventid + ' handler suppressed by Air Lock');
				continue;
			}
			let returnVal;
			if (typeof handler.callback === 'function') {
				let parentEffect = this.effect;
				let parentEffectData = this.effectData;
				this.effect = handler.status;
				this.effectData = handler.statusData || {};
				this.effectData.target = thing;

				returnVal = handler.callback.apply(this, args);

				this.effect = parentEffect;
				this.effectData = parentEffectData;
			} else {
				returnVal = handler.callback;
			}

			if (returnVal !== undefined) {
				relayVar = returnVal;
				if (!relayVar || fastExit) break;
				if (hasRelayVar) {
					args[0] = relayVar;
				}
			}
		}

		this.eventDepth--;
		if (typeof relayVar === 'number' && relayVar === Math.abs(Math.floor(relayVar))) {
			// this.debug(eventid + ' modifier: 0x' + ('0000' + (this.event.modifier * 4096).toString(16)).slice(-4).toUpperCase());
			relayVar = this.modify(relayVar, this.event.modifier);
		}
		this.event = parentEvent;

		return relayVar;
	}

	/**
	 * priorityEvent works just like runEvent, except it exits and returns
	 * on the first non-undefined value instead of only on null/false.
	 */
	priorityEvent(
		eventid: string, target: Pokemon | Side | Battle, source?: Pokemon | null,
		effect?: Effect, relayVar?: any, onEffect?: boolean): any {
		return this.runEvent(eventid, target, source, effect, relayVar, onEffect, true);
	}

	resolveLastPriority(handlers: AnyObject[], callbackName: string) {
		let handler = handlers[handlers.length - 1];
		handler.order = handler.status[`${callbackName}Order`] || false;
		handler.priority = handler.status[`${callbackName}Priority`] || 0;
		handler.subOrder = handler.status[`${callbackName}SubOrder`] || 0;
		if (handler.thing && handler.thing.getStat) handler.speed = handler.thing.speed;
	}

	findEventHandlers(thing: Pokemon | Side | Battle, eventName: string, sourceThing?: Pokemon | null) {
		let handlers: AnyObject[] = [];
		if (thing instanceof Pokemon && thing.isActive) {
			handlers = this.findPokemonEventHandlers(thing, `on${eventName}`);
			for (const allyActive of thing.side.active) {
				if (!allyActive || allyActive.fainted) continue;
				handlers.push(...this.findPokemonEventHandlers(allyActive, `onAlly${eventName}`));
				handlers.push(...this.findPokemonEventHandlers(allyActive, `onAny${eventName}`));
			}
			for (const foeActive of thing.side.foe.active) {
				if (!foeActive || foeActive.fainted) continue;
				handlers.push(...this.findPokemonEventHandlers(foeActive, `onFoe${eventName}`));
				handlers.push(...this.findPokemonEventHandlers(foeActive, `onAny${eventName}`));
			}
			thing = thing.side;
		}
		if (sourceThing) {
			handlers.push(...this.findPokemonEventHandlers(sourceThing, `onSource${eventName}`));
		}
		if (thing instanceof Side) {
			handlers.push(...this.findSideEventHandlers(thing, `on${eventName}`));
			handlers.push(...this.findSideEventHandlers(thing, `onAny${eventName}`));
			handlers.push(...this.findSideEventHandlers(thing.foe, `onFoe${eventName}`));
			handlers.push(...this.findSideEventHandlers(thing.foe, `onAny${eventName}`));
		}
		handlers.push(...this.findBattleEventHandlers(`on${eventName}`));
		return handlers;
	}

	findPokemonEventHandlers(pokemon: Pokemon, callbackName: string, getKey?: 'duration') {
		let handlers: AnyObject[] = [];

		let status = pokemon.getStatus();
		// @ts-ignore
		let callback = status[callbackName];
		if (callback !== undefined || (getKey && pokemon.statusData[getKey])) {
			handlers.push({status, callback, statusData: pokemon.statusData, end: pokemon.clearStatus, thing: pokemon});
			this.resolveLastPriority(handlers, callbackName);
		}
		for (let i in pokemon.volatiles) {
			let volatileData = pokemon.volatiles[i];
			let volatile = pokemon.getVolatile(i);
			// @ts-ignore
			callback = volatile[callbackName];
			if (callback !== undefined || (getKey && volatileData[getKey])) {
				handlers.push({status: volatile, callback, statusData: volatileData, end: pokemon.removeVolatile, thing: pokemon});
				this.resolveLastPriority(handlers, callbackName);
			}
		}
		let ability = pokemon.getAbility();
		// @ts-ignore
		callback = ability[callbackName];
		if (callback !== undefined || (getKey && pokemon.abilityData[getKey])) {
			handlers.push({status: ability, callback, statusData: pokemon.abilityData, end: pokemon.clearAbility, thing: pokemon});
			this.resolveLastPriority(handlers, callbackName);
		}
		let item = pokemon.getItem();
		// @ts-ignore
		callback = item[callbackName];
		if (callback !== undefined || (getKey && pokemon.itemData[getKey])) {
			handlers.push({status: item, callback, statusData: pokemon.itemData, end: pokemon.clearItem, thing: pokemon});
			this.resolveLastPriority(handlers, callbackName);
		}
		let species = pokemon.baseTemplate;
		// @ts-ignore
		callback = species[callbackName];
		if (callback !== undefined) {
			handlers.push({status: species, callback, statusData: pokemon.speciesData, end() {}, thing: pokemon});
			this.resolveLastPriority(handlers, callbackName);
		}

		return handlers;
	}

	findBattleEventHandlers(callbackName: string, getKey?: 'duration') {
		let callbackNamePriority = `${callbackName}Priority`;
		let handlers: AnyObject[] = [];

		let callback;
		for (let i in this.pseudoWeather) {
			let pseudoWeatherData = this.pseudoWeather[i];
			let pseudoWeather = this.getPseudoWeather(i);
			// @ts-ignore
			callback = pseudoWeather[callbackName];
			if (callback !== undefined || (getKey && pseudoWeatherData[getKey])) {
				handlers.push({status: pseudoWeather, callback, statusData: pseudoWeatherData, end: this.removePseudoWeather, thing: this});
				this.resolveLastPriority(handlers, callbackName);
			}
		}
		let weather = this.getWeather();
		// @ts-ignore
		callback = weather[callbackName];
		if (callback !== undefined || (getKey && this.weatherData[getKey])) {
			handlers.push({
				status: weather, callback, statusData: this.weatherData, end: this.clearWeather, thing: this,
				// @ts-ignore
				priority: weather[callbackNamePriority] || 0});
			this.resolveLastPriority(handlers, callbackName);
		}
		let terrain = this.getTerrain();
		// @ts-ignore
		callback = terrain[callbackName];
		if (callback !== undefined || (getKey && this.terrainData[getKey])) {
			handlers.push({
				status: terrain, callback, statusData: this.terrainData, end: this.clearTerrain, thing: this,
				// @ts-ignore
				priority: terrain[callbackNamePriority] || 0});
			this.resolveLastPriority(handlers, callbackName);
		}
		let format = this.getFormat();
		// @ts-ignore
		callback = format[callbackName];
		// @ts-ignore
		if (callback !== undefined || (getKey && this.formatData[getKey])) {
			handlers.push({
				status: format, callback, statusData: this.formatData, end() {}, thing: this,
				// @ts-ignore
				priority: format[callbackNamePriority] || 0});
			this.resolveLastPriority(handlers, callbackName);
		}
		// tslint:disable-next-line:no-conditional-assignment
		if (this.events && (callback = this.events[callbackName]) !== undefined) {
			for (const handler of callback) {
				let statusData = (handler.target.effectType === 'Format') ? this.formatData : undefined;
				handlers.push({
					status: handler.target, callback: handler.callback, statusData, end() {},
					thing: this, priority: handler.priority, order: handler.order, subOrder: handler.subOrder});
			}
		}
		return handlers;
	}

	findSideEventHandlers(side: Side, callbackName: string, getKey?: 'duration') {
		let handlers: AnyObject[] = [];

		for (let i in side.sideConditions) {
			let sideConditionData = side.sideConditions[i];
			let sideCondition = side.getSideCondition(i);
			// @ts-ignore
			let callback = sideCondition[callbackName];
			if (callback !== undefined || (getKey && sideConditionData[getKey])) {
				handlers.push({status: sideCondition, callback, statusData: sideConditionData, end: side.removeSideCondition, thing: side});
				this.resolveLastPriority(handlers, callbackName);
			}
		}
		return handlers;
	}

	/**
	 * Use this function to attach custom event handlers to a battle. See Battle#runEvent for
	 * more information on how to write callbacks for event handlers.
	 *
	 * Try to use this sparingly. Most event handlers can be simply placed in a format instead.
	 *
	 *     this.onEvent(eventid, target, callback)
	 * will set the callback as an event handler for the target when eventid is called with the
	 * default priority. Currently only valid formats are supported as targets but this will
	 * eventually be expanded to support other target types.
	 *
	 *     this.onEvent(eventid, target, priority, callback)
	 * will set the callback as an event handler for the target when eventid is called with the
	 * provided priority. Priority can either be a number or an object that contains the priority,
	 * order, and subOrder for the event handler as needed (undefined keys will use default values)
	 */
	onEvent(eventid: string, target: Format, ...rest: AnyObject[]) { // rest = [priority, callback]
		if (!eventid) throw new TypeError("Event handlers must have an event to listen to");
		if (!target) throw new TypeError("Event handlers must have a target");
		if (!rest.length) throw new TypeError("Event handlers must have a callback");

		if (target.effectType !== 'Format') {
			throw new TypeError(`${target.name} is a ${target.effectType} but only Format targets are supported right now`);
		}

		// tslint:disable-next-line:one-variable-per-declaration
		let callback, priority, order, subOrder, data;
		if (rest.length === 1) {
			[callback] = rest;
			priority = 0;
			order = false;
			subOrder = 0;
		} else {
			[data, callback] = rest;
			if (typeof data === 'object') {
				priority = data['priority'] || 0;
				order = data['order'] || false;
				subOrder = data['subOrder'] || 0;
			} else {
				priority = data || 0;
				order = false;
				subOrder = 0;
			}
		}

		let eventHandler = {callback, target, priority, order, subOrder};

		if (!this.events) this.events = {};
		let callbackName = `on${eventid}`;
		let eventHandlers = this.events[callbackName];
		if (eventHandlers === undefined) {
			this.events[callbackName] = [eventHandler];
		} else {
			eventHandlers.push(eventHandler);
		}
	}

	getPokemon(id: string | Pokemon) {
		if (typeof id !== 'string') id = id.id;
		for (const pokemon of this.p1.pokemon) {
			if (pokemon.id === id) return pokemon;
		}
		for (const pokemon of this.p2.pokemon) {
			if (pokemon.id === id) return pokemon;
		}
		return null;
	}

	makeRequest(type?: string) {
		if (type) {
			this.currentRequest = type;
			this.p1.clearChoice();
			this.p2.clearChoice();
		} else {
			type = this.currentRequest;
		}

		// default to no request
		let p1request: any = null;
		let p2request: any = null;
		this.p1.currentRequest = '';
		this.p2.currentRequest = '';
		let switchTable = [];

		switch (type) {
		case 'switch': {
			for (const active of this.p1.active) {
				switchTable.push(!!(active && active.switchFlag));
			}
			if (switchTable.some(flag => flag === true)) {
				this.p1.currentRequest = 'switch';
				p1request = {forceSwitch: switchTable, side: this.p1.getRequestData()};
			}
			switchTable = [];
			for (const active of this.p2.active) {
				switchTable.push(!!(active && active.switchFlag));
			}
			if (switchTable.some(flag => flag === true)) {
				this.p2.currentRequest = 'switch';
				p2request = {forceSwitch: switchTable, side: this.p2.getRequestData()};
			}
			break;
		}

		case 'teampreview':
			let teamLengthData = this.getFormat().teamLength;
			let maxTeamSize = teamLengthData && teamLengthData.battle;
			this.add('teampreview' + (maxTeamSize ? '|' + maxTeamSize : ''));
			if (!maxTeamSize) maxTeamSize = 6;
			this.p1.maxTeamSize = maxTeamSize;
			this.p2.maxTeamSize = maxTeamSize;
			this.p1.currentRequest = 'teampreview';
			p1request = {teamPreview: true, maxTeamSize, side: this.p1.getRequestData()};
			this.p2.currentRequest = 'teampreview';
			p2request = {teamPreview: true, maxTeamSize, side: this.p2.getRequestData()};
			break;

		default: {
			this.p1.currentRequest = 'move';
			let activeData = this.p1.active.map(pokemon => pokemon && pokemon.getRequestData());
			p1request = {active: activeData, side: this.p1.getRequestData()};

			this.p2.currentRequest = 'move';
			activeData = this.p2.active.map(pokemon => pokemon && pokemon.getRequestData());
			p2request = {active: activeData, side: this.p2.getRequestData()};
			break;
		}
		}

		if (p1request) {
			if (!this.supportCancel || !p2request) p1request.noCancel = true;
			this.p1.emitRequest(p1request);
		} else {
			this.p1.emitRequest({wait: true, side: this.p1.getRequestData()});
		}

		if (p2request) {
			if (!this.supportCancel || !p1request) p2request.noCancel = true;
			this.p2.emitRequest(p2request);
		} else {
			this.p2.emitRequest({wait: true, side: this.p2.getRequestData()});
		}

		if (this.p1.isChoiceDone() && this.p2.isChoiceDone()) {
			throw new Error(`Choices are done immediately after a request`);
		}
		// SGgame
		if ((this.p1.name === 'SG Server' || this.p2.name === 'SG Server') && (this.getFormat().isWildEncounter || this.getFormat().isTrainerBattle) && !this[(this.p1.name === 'SG Server' ? "p1" : "p2")].isChoiceDone()) {
			Server.decideCOM(this, (this.p1.name === 'SG Server' ? "p1" : "p2"), (this.getFormat().isWildEncounter ? "random" : "trainer"));
			this.checkActions();
		}
	}

	tiebreak() {
		if (this.ended) return false;

		this.inputLog.push(`>tiebreak`);
		this.add('message', "Time's up! Going to tiebreaker...");
		const notFainted = this.sides.map(side => (
			side.pokemon.filter(pokemon => !pokemon.fainted).length
		));
		this.add('-message', this.sides.map((side, i) => (
			`${side.name}: ${notFainted[i]} Pokemon left`
		)).join('; '));
		const maxNotFainted = Math.max(...notFainted);
		let tiedSides = this.sides.filter((side, i) => notFainted[i] === maxNotFainted);
		if (tiedSides.length <= 1) {
			return this.win(tiedSides[0]);
		}

		const hpPercentage = tiedSides.map(side => (
			side.pokemon.map(pokemon => pokemon.hp / pokemon.maxhp).reduce((a, b) => a + b) * 100 / 6
		));
		this.add('-message', tiedSides.map((side, i) => (
			`${side.name}: ${Math.round(hpPercentage[i])}% total HP left`
		)).join('; '));
		const maxPercentage = Math.max(...hpPercentage);
		tiedSides = tiedSides.filter((side, i) => hpPercentage[i] === maxPercentage);
		if (tiedSides.length <= 1) {
			return this.win(tiedSides[0]);
		}

		const hpTotal = tiedSides.map(side => (
			side.pokemon.map(pokemon => pokemon.hp).reduce((a, b) => a + b)
		));
		this.add('-message', tiedSides.map((side, i) => (
			`${side.name}: ${Math.round(hpTotal[i])} total HP left`
		)).join('; '));
		const maxTotal = Math.max(...hpTotal);
		tiedSides = tiedSides.filter((side, i) => hpTotal[i] === maxTotal);
		if (tiedSides.length <= 1) {
			return this.win(tiedSides[0]);
		}
		return this.tie();
	}

	forceWin(side: PlayerSlot | null = null) {
		if (this.ended) return false;

		if (side) {
			this.inputLog.push(`>forcewin ${side}`);
		} else {
			this.inputLog.push(`>forcetie`);
		}
		return this.win(side);
	}

	tie() {
		return this.win();
	}

	win(side?: string | Side | null) {
		if (this.ended) {
			return false;
		}
		if (side === 'p1' || side === 'p2') {
			side = this[side];
		} else if (side !== this.p1 && side !== this.p2) {
			side = null;
		}
		this.winner = side ? side.name : '';

		this.add('');
		if (side) {
			this.add('win', side.name);
		} else {
			this.add('tie');
		}
		this.ended = true;
		this.active = false;
		this.currentRequest = '';
		for (const s of this.sides) {
			s.currentRequest = '';
		}
		return true;
	}

	switchIn(pokemon: Pokemon, pos?: number, sourceEffect: Effect | null = null) {
		if (!pokemon || pokemon.isActive) return false;
		if (!pos) pos = 0;
		let side = pokemon.side;
		if (pos >= side.active.length) {
			throw new Error("Invalid switch position");
		}
		let newMove = null;
		if (side.active[pos]) {
			let oldActive = side.active[pos];
			if (this.gen === 4 && sourceEffect) {
				newMove = oldActive.lastMove;
			}
			if (this.cancelMove(oldActive)) {
				for (const foeActive of side.foe.active) {
					if (foeActive.isStale >= 2) {
						oldActive.isStaleCon++;
						oldActive.isStaleSource = 'drag';
						break;
					}
				}
			}
			if (oldActive.switchCopyFlag) {
				oldActive.switchCopyFlag = false;
				pokemon.copyVolatileFrom(oldActive);
			}
		}
		if (newMove) pokemon.lastMove = newMove;
		pokemon.isActive = true;
		this.runEvent('BeforeSwitchIn', pokemon);
		if (side.active[pos]) {
			let oldActive = side.active[pos];
			oldActive.isActive = false;
			oldActive.isStarted = false;
			oldActive.usedItemThisTurn = false;
			oldActive.position = pokemon.position;
			pokemon.position = pos;
			side.pokemon[pokemon.position] = pokemon;
			side.pokemon[oldActive.position] = oldActive;
			this.cancelMove(oldActive);
			oldActive.clearVolatile();
		}
		side.active[pos] = pokemon;
		pokemon.activeTurns = 0;
		for (let m in pokemon.moveSlots) {
			pokemon.moveSlots[m].used = false;
		}
		this.add('switch', pokemon, pokemon.getDetails);
		if (sourceEffect) this.log[this.log.length - 1] += `|[from]${sourceEffect.fullname}`;
		this.insertQueue({pokemon, choice: 'runUnnerve'});
		this.insertQueue({pokemon, choice: 'runSwitch'});
		// SGgame
		let foe = this[(side.id === 'p1' ? 'p2' : 'p1')].pokemon[0];
		if (side.battled[foe.slot].indexOf(pokemon.slot) < 0) side.battled[foe.slot].push(pokemon.slot);
		if (foe.side.battled[pokemon.slot].indexOf(foe.slot) < 0) foe.side.battled[pokemon.slot].push(foe.slot);
	}

	canSwitch(side: Side) {
		let canSwitchIn = [];
		for (let i = side.active.length; i < side.pokemon.length; i++) {
			let pokemon = side.pokemon[i];
			if (!pokemon.fainted) {
				canSwitchIn.push(pokemon);
			}
		}
		return canSwitchIn.length;
	}

	getRandomSwitchable(side: Side) {
		let canSwitchIn = [];
		for (let i = side.active.length; i < side.pokemon.length; i++) {
			let pokemon = side.pokemon[i];
			if (!pokemon.fainted) {
				canSwitchIn.push(pokemon);
			}
		}
		if (!canSwitchIn.length) {
			return null;
		}
		return this.sample(canSwitchIn);
	}

	dragIn(side: Side, pos?: number) {
		if (!pos) pos = 0;
		if (pos >= side.active.length) return false;
		let pokemon = this.getRandomSwitchable(side);
		if (!pokemon || pokemon.isActive) return false;
		pokemon.isActive = true;
		this.runEvent('BeforeSwitchIn', pokemon);
		if (side.active[pos]) {
			let oldActive = side.active[pos];
			if (!oldActive.hp) {
				return false;
			}
			if (!this.runEvent('DragOut', oldActive)) {
				return false;
			}
			this.runEvent('SwitchOut', oldActive);
			oldActive.illusion = null;
			this.singleEvent('End', this.getAbility(oldActive.ability), oldActive.abilityData, oldActive);
			oldActive.isActive = false;
			oldActive.isStarted = false;
			oldActive.usedItemThisTurn = false;
			oldActive.position = pokemon.position;
			pokemon.position = pos;
			side.pokemon[pokemon.position] = pokemon;
			side.pokemon[oldActive.position] = oldActive;
			if (this.cancelMove(oldActive)) {
				for (const foeActive of side.foe.active) {
					if (foeActive.isStale >= 2) {
						oldActive.isStaleCon++;
						oldActive.isStaleSource = 'drag';
						break;
					}
				}
			}
			oldActive.clearVolatile();
		}
		side.active[pos] = pokemon;
		pokemon.activeTurns = 0;
		if (this.gen === 2) pokemon.draggedIn = this.turn;
		for (let m in pokemon.moveSlots) {
			pokemon.moveSlots[m].used = false;
		}
		this.add('drag', pokemon, pokemon.getDetails);
		if (this.gen >= 5) {
			this.singleEvent('PreStart', pokemon.getAbility(), pokemon.abilityData, pokemon);
			this.runEvent('SwitchIn', pokemon);
			if (!pokemon.hp) return true;
			pokemon.isStarted = true;
			if (!pokemon.fainted) {
				this.singleEvent('Start', pokemon.getAbility(), pokemon.abilityData, pokemon);
				this.singleEvent('Start', pokemon.getItem(), pokemon.itemData, pokemon);
			}
		} else {
			this.insertQueue({pokemon, choice: 'runSwitch'});
		}
		return true;
	}

	swapPosition(pokemon: Pokemon, slot: number, attributes?: string | AnyObject) {
		if (slot >= pokemon.side.active.length) {
			throw new Error("Invalid swap position");
		}
		let target = pokemon.side.active[slot];
		if (slot !== 1 && (!target || target.fainted)) return false;

		this.add('swap', pokemon, slot, attributes || '');

		let side = pokemon.side;
		side.pokemon[pokemon.position] = target;
		side.pokemon[slot] = pokemon;
		side.active[pokemon.position] = side.pokemon[pokemon.position];
		side.active[slot] = side.pokemon[slot];
		if (target) target.position = pokemon.position;
		pokemon.position = slot;
		return true;
	}

	faint(pokemon: Pokemon, source?: Pokemon, effect?: Effect) {
		pokemon.faint(source, effect);
	}

	nextTurn() {
		this.turn++;
		let allStale = true;
		let oneStale: Pokemon | null = null;
		for (const side of this.sides) {
			for (const pokemon of side.active) {
				if (!pokemon) continue;
				pokemon.moveThisTurn = '';
				pokemon.usedItemThisTurn = false;
				pokemon.newlySwitched = false;
				pokemon.moveLastTurnResult = pokemon.moveThisTurnResult;
				pokemon.moveThisTurnResult = undefined;
				pokemon.hurtThisTurn = false;

				pokemon.maybeDisabled = false;
				for (const moveSlot of pokemon.moveSlots) {
					moveSlot.disabled = false;
					moveSlot.disabledSource = '';
				}
				this.runEvent('DisableMove', pokemon);
				if (!pokemon.ateBerry) pokemon.disableMove('belch');

				// If it was an illusion, it's not any more
				if (pokemon.getLastAttackedBy() && this.gen >= 7) pokemon.knownType = true;

				for (let i = pokemon.attackedBy.length - 1; i >= 0; i--) {
					let attack = pokemon.attackedBy[i];
					if (attack.source.isActive) {
						attack.thisTurn = false;
					} else {
						pokemon.attackedBy.splice(pokemon.attackedBy.indexOf(attack), 1);
					}
				}

				if (this.gen >= 7) {
					// In Gen 7, the real type of every Pokemon is visible to all players via the bottom screen while making choices
					const seenPokemon = pokemon.illusion || pokemon;
					const realTypeString = seenPokemon.getTypes(true).join('/');
					if (realTypeString !== seenPokemon.apparentType) {
						this.add('-start', pokemon, 'typechange', realTypeString, '[silent]');
						seenPokemon.apparentType = realTypeString;
						if (pokemon.addedType) {
							// The typechange message removes the added type, so put it back
							this.add('-start', pokemon, 'typeadd', pokemon.addedType, '[silent]');
						}
					}
				}

				pokemon.trapped = pokemon.maybeTrapped = false;
				this.runEvent('TrapPokemon', pokemon);
				if (!pokemon.knownType || this.getImmunity('trapped', pokemon)) {
					this.runEvent('MaybeTrapPokemon', pokemon);
				}
				// canceling switches would leak information
				// if a foe might have a trapping ability
				if (this.gen > 2) {
					for (const source of pokemon.side.foe.active) {
						if (!source || source.fainted) continue;
						let template = (source.illusion || source).template;
						if (!template.abilities) continue;
						for (let abilitySlot in template.abilities) {
							// @ts-ignore
							let abilityName = template.abilities[abilitySlot];
							if (abilityName === source.ability) {
								// pokemon event was already run above so we don't need
								// to run it again.
								continue;
							}
							const ruleTable = this.getRuleTable(this.getFormat());
							if (!ruleTable.has('-illegal') && !this.getFormat().team) {
								// hackmons format
								continue;
							} else if (abilitySlot === 'H' && template.unreleasedHidden) {
								// unreleased hidden ability
								continue;
							}
							let ability = this.getAbility(abilityName);
							if (ruleTable.has('-ability:' + ability.id)) continue;
							if (pokemon.knownType && !this.getImmunity('trapped', pokemon)) continue;
							this.singleEvent('FoeMaybeTrapPokemon', ability, {}, pokemon, source);
						}
					}
				}

				if (pokemon.fainted) continue;
				if (pokemon.isStale < 2) {
					if (pokemon.isStaleCon >= 2) {
						if (pokemon.hp >= pokemon.isStaleHP - pokemon.maxhp / 100) {
							pokemon.isStale++;
							if (this.firstStaleWarned && pokemon.isStale < 2) {
								switch (pokemon.isStaleSource) {
								case 'struggle':
									this.add('bigerror', `${pokemon.name} isn't losing HP from Struggle. If this continues, it will be classified as being in an endless loop`);
									break;
								case 'drag':
									this.add('bigerror', `${pokemon.name} isn't losing PP or HP from being forced to switch. If this continues, it will be classified as being in an endless loop`);
									break;
								case 'switch':
									this.add('bigerror', `${pokemon.name} isn't losing PP or HP from repeatedly switching. If this continues, it will be classified as being in an endless loop`);
									break;
								}
							}
						}
						pokemon.isStaleCon = 0;
						pokemon.isStalePPTurns = 0;
						pokemon.isStaleHP = pokemon.hp;
					}
					if (pokemon.isStalePPTurns >= 5) {
						if (pokemon.hp >= pokemon.isStaleHP - pokemon.maxhp / 100) {
							pokemon.isStale++;
							pokemon.isStaleSource = 'ppstall';
							if (this.firstStaleWarned && pokemon.isStale < 2) {
								this.add('bigerror', `${pokemon.name} isn't losing PP or HP. If it keeps on not losing PP or HP, it will be classified as being in an endless loop.`);
							}
						}
						pokemon.isStaleCon = 0;
						pokemon.isStalePPTurns = 0;
						pokemon.isStaleHP = pokemon.hp;
					}
				}
				if (pokemon.getMoves().length === 0) {
					pokemon.isStaleCon++;
					pokemon.isStaleSource = 'struggle';
				}
				if (pokemon.isStale < 2) {
					allStale = false;
				} else if (pokemon.isStale && !pokemon.staleWarned) {
					oneStale = pokemon;
				}
				if (!pokemon.isStalePPTurns) {
					pokemon.isStaleHP = pokemon.hp;
					if (pokemon.activeTurns) pokemon.isStaleCon = 0;
				}
				if (pokemon.activeTurns) {
					pokemon.isStalePPTurns++;
				}
				pokemon.activeTurns++;
			}
			side.faintedLastTurn = side.faintedThisTurn;
			side.faintedThisTurn = false;
		}
		const ruleTable = this.getRuleTable(this.getFormat());
		if (ruleTable.has('endlessbattleclause')) {
			if (oneStale) {
				let activationWarning = ` - If all active Pok\u00e9mon go in an endless loop, Endless Battle Clause will activate.`;
				if (allStale) activationWarning = ``;
				let loopReason = ``;
				switch (oneStale.isStaleSource) {
				case 'struggle':
					loopReason = `: it isn't losing HP from Struggle`;
					break;
				case 'drag':
					loopReason = `: it isn't losing PP or HP from being forced to switch`;
					break;
				case 'switch':
					loopReason = `: it isn't losing PP or HP from repeatedly switching`;
					break;
				case 'getleppa':
					loopReason = `: it got a Leppa Berry it didn't start with`;
					break;
				case 'useleppa':
					loopReason = `: it used a Leppa Berry it didn't start with`;
					break;
				case 'ppstall':
					loopReason = `: it isn't losing PP or HP`;
					break;
				case 'ppoverflow':
					loopReason = `: its PP overflowed`;
					break;
				}
				this.add('bigerror', `${oneStale.name} is in an endless loop${loopReason}.${activationWarning}`);
				oneStale.staleWarned = true;
				this.firstStaleWarned = true;
			}
			if (allStale) {
				this.add('message', `All active Pok\u00e9mon are in an endless loop. Endless Battle Clause activated!`);
				let leppaPokemon = null;
				for (const side of this.sides) {
					for (const pokemon of side.pokemon) {
						if (toId(pokemon.set.item) === 'leppaberry') {
							if (leppaPokemon) {
								leppaPokemon = null; // both sides have Leppa
								this.add('-message', `Both sides started with a Leppa Berry.`);
							} else {
								leppaPokemon = pokemon;
							}
							break;
						}
					}
				}
				if (leppaPokemon) {
					this.add('-message', `${leppaPokemon.side.name}'s ${leppaPokemon.name} started with a Leppa Berry and loses.`);
					this.win(leppaPokemon.side.foe);
					return;
				}
				this.win();
				return;
			}
			if ((this.turn >= 500 && this.turn % 100 === 0) ||
				(this.turn >= 900 && this.turn % 10 === 0) ||
				(this.turn >= 990)) {
				const turnsLeft = 1000 - this.turn;
				if (turnsLeft < 0) {
					this.add('message', `It is turn 1000. Endless Battle Clause activated!`);
					this.tie();
					return;
				}
				const turnsLeftText = (turnsLeft === 1 ? `1 turn` : `${turnsLeft} turns`);
				this.add('bigerror', `You will auto-tie if the battle doesn't end in ${turnsLeftText} (on turn 1000).`);
			}
		} else {
			if (allStale && !this.staleWarned) {
				this.staleWarned = true;
				this.add('bigerror', `If this format had Endless Battle Clause, it would have activated.`);
			} else if (oneStale) {
				this.add('bigerror', `${oneStale.name} is in an endless loop.`);
				oneStale.staleWarned = true;
			}
		}

		if (this.gameType === 'triples' && !this.sides.filter(side => side.pokemonLeft > 1).length) {
			// If both sides have one Pokemon left in triples and they are not adjacent, they are both moved to the center.
			let actives = [];
			for (const side of this.sides) {
				for (const pokemon of side.active) {
					if (!pokemon || pokemon.fainted) continue;
					actives.push(pokemon);
				}
			}
			if (actives.length > 1 && !this.isAdjacent(actives[0], actives[1])) {
				this.swapPosition(actives[0], 1, '[silent]');
				this.swapPosition(actives[1], 1, '[silent]');
				this.add('-center');
			}
		}

		this.add('turn', this.turn);

		this.makeRequest('move');
		// SGgame
		if (this.getFormat().isWildEncounter) {
			let balls = ['pokeball', 'greatball', 'ultraball', 'masterball'];
			let buttons = '';
			for (let i = 0; i < balls.length; i++) {
				buttons += '<button name="send" value="/throwpokeball ' + balls[i] + '" style="background:transparent;border:none;"><img src="http://www.serebii.net/itemdex/sprites/pgl/' + balls[i] + '.png" width="30" height="30"></button>&nbsp;&nbsp;';
			}
			this.add('raw', buttons);
			this.add('');
		 }
	}

	start() {
		if (this.active) return;

		if (!this.p1 || !this.p2) {
			// need two players to start
			return;
		}

		if (this.started) {
			return;
		}
		this.activeTurns = 0;
		this.started = true;
		this.p2.foe = this.p1;
		this.p1.foe = this.p2;

		for (const side of this.sides) {
			this.add('teamsize', side.id, side.pokemon.length);
		}

		this.add('gametype', this.gameType);
		this.add('gen', this.gen);

		let format = this.getFormat();

		this.add('tier', format.name);
		if (this.rated) {
			if (this.rated === 'Rated battle') this.rated = true;
			this.add('rated', typeof this.rated === 'string' ? this.rated : '');
		}
		this.add('seed', (side: Side) => Battle.logReplay(this.prngSeed.join(','), side));

		if (format.onBegin) {
			format.onBegin.call(this);
		}
		for (const rule of this.getRuleTable(format).keys()) {
			if (rule.startsWith('+') || rule.startsWith('-') || rule.startsWith('!')) continue;
			let subFormat = this.getFormat(rule);
			if (subFormat.exists) {
				if (subFormat.onBegin) subFormat.onBegin.call(this);
			}
		}

		if (!this.p1.pokemon[0] || !this.p2.pokemon[0]) {
			throw new Error('Battle not started: A player has an empty team.');
		}

		this.residualEvent('TeamPreview');

		this.addToQueue({choice: 'start'});
		this.midTurn = true;
		if (!this.currentRequest) this.go();
	}

	boost(
		boost: SparseBoostsTable, target: Pokemon | null = null, source: Pokemon | null = null,
		effect: Effect | null = null, isSecondary: boolean = false, isSelf: boolean = false) {
		if (this.event) {
			if (!target) target = this.event.target;
			if (!source) source = this.event.source;
			if (!effect) effect = this.effect;
		}
		if (!target || !target.hp) return 0;
		if (!target.isActive) return false;
		if (this.gen > 5 && !target.side.foe.pokemonLeft) return false;
		boost = this.runEvent('Boost', target, source, effect, Object.assign({}, boost));
		let success = null;
		let boosted = false;
		for (let i in boost) {
			let currentBoost: SparseBoostsTable = {};
			// @ts-ignore
			currentBoost[i] = boost[i];
			let boostBy = target.boostBy(currentBoost);
			let msg = '-boost';
			// @ts-ignore
			if (boost[i] < 0) {
				msg = '-unboost';
				boostBy = -boostBy;
			}
			if (boostBy) {
				success = true;
				switch (effect && effect.id) {
				case 'bellydrum':
					this.add('-setboost', target, 'atk', target.boosts['atk'], '[from] move: Belly Drum');
					break;
				case 'bellydrum2':
					this.add(msg, target, i, boostBy, '[silent]');
					this.hint("In Gen 2, Belly Drum boosts by 2 when it fails.");
					break;
				case 'intimidate': case 'gooey': case 'tanglinghair':
					this.add(msg, target, i, boostBy);
					break;
				case 'zpower':
					this.add(msg, target, i, boostBy, '[zeffect]');
					break;
				default:
					if (!effect) break;
					if (effect.effectType === 'Move') {
						this.add(msg, target, i, boostBy);
					} else {
						if (effect.effectType === 'Ability' && !boosted) {
							this.add('-ability', target, effect.name, 'boost');
							boosted = true;
						}
						this.add(msg, target, i, boostBy);
					}
					break;
				}
				this.runEvent('AfterEachBoost', target, source, effect, currentBoost);
			} else if (effect && effect.effectType === 'Ability') {
				if (isSecondary) this.add(msg, target, i, boostBy);
			} else if (!isSecondary && !isSelf) {
				this.add(msg, target, i, boostBy);
			}
		}
		this.runEvent('AfterBoost', target, source, effect, boost);
		return success;
	}

	damage(
		damage: number, target: Pokemon | null = null, source: Pokemon | null = null,
		effect: 'drain' | 'recoil' | Effect | null = null, instafaint: boolean = false) {
		if (this.event) {
			if (!target) target = this.event.target;
			if (!source) source = this.event.source;
			if (!effect) effect = this.effect;
		}
		if (!target || !target.hp) return 0;
		if (!target.isActive) return false;
		if (!(damage || damage === 0)) return damage;
		if (damage !== 0) damage = this.clampIntRange(damage, 1);

		if (typeof effect === 'string' || !effect) effect = this.getEffect(effect);

		if (effect.id !== 'struggle-recoil') { // Struggle recoil is not affected by effects
			if (effect.effectType === 'Weather' && !target.runStatusImmunity(effect.id)) {
				this.debug('weather immunity');
				return 0;
			}
			damage = this.runEvent('Damage', target, source, effect, damage);
			if (!(damage || damage === 0)) {
				this.debug('damage event failed');
				return damage;
			}
		}
		if (damage !== 0) damage = this.clampIntRange(damage, 1);

		if (this.gen <= 1) {
			if (this.currentMod === 'stadium' ||
				!['recoil', 'drain'].includes(effect.id) && effect.effectType !== 'Status') {
				this.lastDamage = damage;
			}
		}

		damage = target.damage(damage, source, effect);
		if (damage !== 0) target.hurtThisTurn = true;
		if (source && effect.effectType === 'Move') source.lastDamage = damage;

		let name = effect.fullname;
		if (name === 'tox') name = 'psn';
		switch (effect.id) {
		case 'partiallytrapped':
			this.add('-damage', target, target.getHealth, '[from] ' + this.effectData.sourceEffect.fullname, '[partiallytrapped]');
			break;
		case 'powder':
			this.add('-damage', target, target.getHealth, '[silent]');
			break;
		case 'confused':
			this.add('-damage', target, target.getHealth, '[from] confusion');
			break;
		default:
			if (effect.effectType === 'Move' || !name) {
				this.add('-damage', target, target.getHealth);
			} else if (source && (source !== target || effect.effectType === 'Ability')) {
				this.add('-damage', target, target.getHealth, '[from] ' + name, '[of] ' + source);
			} else {
				this.add('-damage', target, target.getHealth, '[from] ' + name);
			}
			break;
		}

		if (damage) {
			if (this.gen <= 1 && effect.recoil && source) {
				this.damage(this.clampIntRange(Math.floor(damage * effect.recoil[0] / effect.recoil[1]), 1), source, target, 'recoil');
			}
			if (this.gen <= 4 && effect.drain && source) {
				this.heal(this.clampIntRange(Math.floor(damage * effect.drain[0] / effect.drain[1]), 1), source, target, 'drain');
			}
			if (this.gen > 4 && effect.drain && source) {
				this.heal(Math.round(damage * effect.drain[0] / effect.drain[1]), source, target, 'drain');
			}
		}

		// @ts-ignore TODO: AfterDamage passes an Effect, not an ActiveMove
		if (!effect.flags) effect.flags = {};

		if (instafaint && target.hp <= 0) {
			this.debug('instafaint: ' + this.faintQueue.map(entry => entry.target.name));
			this.faintMessages(true);
			if (this.gen <= 2) {
				target.faint();
				if (this.gen <= 1) this.queue = [];
			}
		} else {
			damage = this.runEvent('AfterDamage', target, source, effect, damage);
		}

		return damage;
	}

	directDamage(damage: number, target?: Pokemon, source: Pokemon | null = null, effect: Effect | null = null) {
		if (this.event) {
			if (!target) target = this.event.target;
			if (!source) source = this.event.source;
			if (!effect) effect = this.effect;
		}
		if (!target || !target.hp) return 0;
		if (!damage) return 0;
		damage = this.clampIntRange(damage, 1);

		if (typeof effect === 'string' || !effect) effect = this.getEffect(effect);

		// In Gen 1 BUT NOT STADIUM, Substitute also takes confusion and HJK recoil damage
		if (this.gen <= 1 && this.currentMod !== 'stadium' &&
			['confusion', 'jumpkick', 'highjumpkick'].includes(effect.id) && target.volatiles['substitute']) {

			const hint = "In Gen 1, if a Pokemon with a Substitute hurts itself due to confusion or Jump Kick/Hi Jump Kick recoil and the target";
			if (source && source.volatiles['substitute']) {
				source.volatiles['substitute'].hp -= damage;
				if (source.volatiles['substitute'].hp <= 0) {
					source.removeVolatile('substitute');
					source.subFainted = true;
				} else {
					this.add('-activate', source, 'Substitute', '[damage]');
				}
				this.hint(hint + " has a Substitute, the target's Substitute takes the damage.");
				return damage;
			} else {
				this.hint(hint + " does not have a Substitute there is no damage dealt.");
				return 0;
			}
		}

		damage = target.damage(damage, source, effect);
		switch (effect.id) {
		case 'strugglerecoil':
			this.add('-damage', target, target.getHealth, '[from] recoil');
			break;
		case 'confusion':
			this.add('-damage', target, target.getHealth, '[from] confusion');
			break;
		default:
			this.add('-damage', target, target.getHealth);
			break;
		}
		if (target.fainted) this.faint(target);
		return damage;
	}

	heal(damage: number, target?: Pokemon, source: Pokemon | null = null, effect: 'drain' | Effect | null = null) {
		if (this.event) {
			if (!target) target = this.event.target;
			if (!source) source = this.event.source;
			if (!effect) effect = this.effect;
		}
		if (effect === 'drain') effect = this.getEffect(effect);
		if (damage && damage <= 1) damage = 1;
		damage = this.trunc(damage);
		// for things like Liquid Ooze, the Heal event still happens when nothing is healed.
		damage = this.runEvent('TryHeal', target, source, effect, damage);
		if (!damage) return damage;
		if (!target || !target.hp) return false;
		if (!target.isActive) return false;
		if (target.hp >= target.maxhp) return false;
		let finalDamage = target.heal(damage, source, effect);
		switch (effect && effect.id) {
		case 'leechseed':
		case 'rest':
			this.add('-heal', target, target.getHealth, '[silent]');
			break;
		case 'drain':
			this.add('-heal', target, target.getHealth, '[from] drain', '[of] ' + source);
			break;
		case 'wish':
			break;
		case 'zpower':
			this.add('-heal', target, target.getHealth, '[zeffect]');
			break;
		default:
			if (!effect) break;
			if (effect.effectType === 'Move') {
				this.add('-heal', target, target.getHealth);
			} else if (source && source !== target) {
				this.add('-heal', target, target.getHealth, '[from] ' + effect.fullname, '[of] ' + source);
			} else {
				this.add('-heal', target, target.getHealth, '[from] ' + effect.fullname);
			}
			break;
		}
		this.runEvent('Heal', target, source, effect, finalDamage);
		return finalDamage;
	}

	chain(previousMod: number | number[], nextMod: number | number[]) {
		// previousMod or nextMod can be either a number or an array [numerator, denominator]
		if (Array.isArray(previousMod)) {
			previousMod = this.trunc(previousMod[0] * 4096 / previousMod[1]);
		} else {
			previousMod = this.trunc(previousMod * 4096);
		}

		if (Array.isArray(nextMod)) {
			nextMod = this.trunc(nextMod[0] * 4096 / nextMod[1]);
		} else {
			nextMod = this.trunc(nextMod * 4096);
		}
		return ((previousMod * nextMod + 2048) >> 12) / 4096; // M'' = ((M * M') + 0x800) >> 12
	}

	chainModify(numerator: number | number[], denominator?: number) {
		let previousMod = this.trunc(this.event.modifier * 4096);

		if (Array.isArray(numerator)) {
			denominator = numerator[1];
			numerator = numerator[0];
		}
		let nextMod = 0;
		if (this.event.ceilModifier) {
			nextMod = Math.ceil(numerator * 4096 / (denominator || 1));
		} else {
			nextMod = this.trunc(numerator * 4096 / (denominator || 1));
		}

		this.event.modifier = ((previousMod * nextMod + 2048) >> 12) / 4096;
	}

	modify(value: number, numerator: number | number[], denominator?: number) {
		// You can also use:
		// modify(value, [numerator, denominator])
		// modify(value, fraction) - assuming you trust JavaScript's floating-point handler
		if (!denominator) denominator = 1;
		if (Array.isArray(numerator)) {
			denominator = numerator[1];
			numerator = numerator[0];
		}
		const tr = this.trunc;
		let modifier = tr(numerator * 4096 / denominator);
		return tr((tr(value * modifier) + 2048 - 1) / 4096);
	}

	getCategory(move: string | Move) {
		move = this.getMove(move);
		return move.category || 'Physical';
	}

	/**
	 * 0 is a success dealing 0 damage, such as from False Swipe at 1 HP.
	 *
	 * Normal PS return value rules apply:
	 * undefined = success, null = silent failure, false = loud failure
	 */
	getDamage(
		pokemon: Pokemon, target: Pokemon, move: string | number | ActiveMove,
		suppressMessages: boolean = false): number | undefined | null | false {
		if (typeof move === 'string') move = this.getActiveMove(move);

		if (typeof move === 'number') {
			let basePower = move;
			// @ts-ignore
			move = (new Data.Move({
				basePower,
				type: '???',
				category: 'Physical',
				willCrit: false,
			})) as ActiveMove;
			move.hit = 0;
		}

		if (!move.ignoreImmunity || (move.ignoreImmunity !== true && !move.ignoreImmunity[move.type])) {
			if (!target.runImmunity(move.type, !suppressMessages)) {
				return false;
			}
		}

		if (move.ohko) {
			return target.maxhp;
		}

		if (move.damageCallback) {
			return move.damageCallback.call(this, pokemon, target);
		}
		if (move.damage === 'level') {
			return pokemon.level;
		} else if (move.damage) {
			return move.damage;
		}

		let category = this.getCategory(move);
		let defensiveCategory = move.defensiveCategory || category;

		let basePower: number | false | null = move.basePower;
		if (move.basePowerCallback) {
			basePower = move.basePowerCallback.call(this, pokemon, target, move);
		}
		if (!basePower) {
			return basePower === 0 ? undefined : basePower;
		}
		basePower = this.clampIntRange(basePower, 1);

		let critMult;
		let critRatio = this.runEvent('ModifyCritRatio', pokemon, target, move, move.critRatio || 0);
		if (this.gen <= 5) {
			critRatio = this.clampIntRange(critRatio, 0, 5);
			critMult = [0, 16, 8, 4, 3, 2];
		} else {
			critRatio = this.clampIntRange(critRatio, 0, 4);
			if (this.gen === 6) {
				critMult = [0, 16, 8, 2, 1];
			} else {
				critMult = [0, 24, 8, 2, 1];
			}
		}

		move.crit = move.willCrit || false;
		if (move.willCrit === undefined) {
			if (critRatio) {
				move.crit = this.randomChance(1, critMult[critRatio]);
			}
		}

		if (move.crit) {
			move.crit = this.runEvent('CriticalHit', target, null, move);
		}

		// happens after crit calculation
		basePower = this.runEvent('BasePower', pokemon, target, move, basePower, true);

		if (!basePower) return 0;
		basePower = this.clampIntRange(basePower, 1);

		let level = pokemon.level;

		let attacker = pokemon;
		let defender = target;
		let attackStat: StatNameExceptHP = category === 'Physical' ? 'atk' : 'spa';
		let defenseStat: StatNameExceptHP = defensiveCategory === 'Physical' ? 'def' : 'spd';
		let statTable = {atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe'};
		let attack;
		let defense;

		// @ts-ignore
		let atkBoosts = move.useTargetOffensive ? defender.boosts[attackStat] : attacker.boosts[attackStat];
		// @ts-ignore
		let defBoosts = move.useSourceDefensive ? attacker.boosts[defenseStat] : defender.boosts[defenseStat];

		let ignoreNegativeOffensive = !!move.ignoreNegativeOffensive;
		let ignorePositiveDefensive = !!move.ignorePositiveDefensive;

		if (move.crit) {
			ignoreNegativeOffensive = true;
			ignorePositiveDefensive = true;
		}
		let ignoreOffensive = !!(move.ignoreOffensive || (ignoreNegativeOffensive && atkBoosts < 0));
		let ignoreDefensive = !!(move.ignoreDefensive || (ignorePositiveDefensive && defBoosts > 0));

		if (ignoreOffensive) {
			this.debug('Negating (sp)atk boost/penalty.');
			atkBoosts = 0;
		}
		if (ignoreDefensive) {
			this.debug('Negating (sp)def boost/penalty.');
			defBoosts = 0;
		}

		if (move.useTargetOffensive) {
			attack = defender.calculateStat(attackStat, atkBoosts);
		} else {
			attack = attacker.calculateStat(attackStat, atkBoosts);
		}

		if (move.useSourceDefensive) {
			defense = attacker.calculateStat(defenseStat, defBoosts);
		} else {
			defense = defender.calculateStat(defenseStat, defBoosts);
		}

		// Apply Stat Modifiers
		// @ts-ignore
		attack = this.runEvent('Modify' + statTable[attackStat], attacker, defender, move, attack);
		// @ts-ignore
		defense = this.runEvent('Modify' + statTable[defenseStat], defender, attacker, move, defense);

		const tr = this.trunc;

		// int(int(int(2 * L / 5 + 2) * A * P / D) / 50);
		let baseDamage = tr(tr(tr(tr(2 * level / 5 + 2) * basePower * attack) / defense) / 50);

		// Calculate damage modifiers separately (order differs between generations)
		return this.modifyDamage(baseDamage, pokemon, target, move, suppressMessages);
	}

	modifyDamage(baseDamage: number, pokemon: Pokemon, target: Pokemon, move: ActiveMove, suppressMessages: boolean = false) {
		const tr = this.trunc;
		if (!move.type) move.type = '???';
		let type = move.type;

		baseDamage += 2;

		// multi-target modifier (doubles only)
		if (move.spreadHit) {
			let spreadModifier = move.spreadModifier || 0.75;
			this.debug('Spread modifier: ' + spreadModifier);
			baseDamage = this.modify(baseDamage, spreadModifier);
		}

		// weather modifier
		baseDamage = this.runEvent('WeatherModifyDamage', pokemon, target, move, baseDamage);

		// crit - not a modifier
		if (move.crit) {
			baseDamage = tr(baseDamage * (move.critModifier || (this.gen >= 6 ? 1.5 : 2)));
		}

		// random factor - also not a modifier
		baseDamage = this.randomizer(baseDamage);

		// STAB
		if (move.forceSTAB || (type !== '???' && pokemon.hasType(type))) {
			// The "???" type never gets STAB
			// Not even if you Roost in Gen 4 and somehow manage to use
			// Struggle in the same turn.
			// (On second thought, it might be easier to get a Missingno.)
			baseDamage = this.modify(baseDamage, move.stab || 1.5);
		}
		// types
		move.typeMod = target.runEffectiveness(move);

		move.typeMod = this.clampIntRange(move.typeMod, -6, 6);
		if (move.typeMod > 0) {
			if (!suppressMessages) this.add('-supereffective', target);

			for (let i = 0; i < move.typeMod; i++) {
				baseDamage *= 2;
			}
		}
		if (move.typeMod < 0) {
			if (!suppressMessages) this.add('-resisted', target);

			for (let i = 0; i > move.typeMod; i--) {
				baseDamage = tr(baseDamage / 2);
			}
		}

		if (move.crit && !suppressMessages) this.add('-crit', target);

		if (pokemon.status === 'brn' && move.category === 'Physical' && !pokemon.hasAbility('guts')) {
			if (this.gen < 6 || move.id !== 'facade') {
				baseDamage = this.modify(baseDamage, 0.5);
			}
		}

		// Generation 5, but nothing later, sets damage to 1 before the final damage modifiers
		if (this.gen === 5 && !baseDamage) baseDamage = 1;

		// Final modifier. Modifiers that modify damage after min damage check, such as Life Orb.
		baseDamage = this.runEvent('ModifyDamage', pokemon, target, move, baseDamage);

		if (move.isZPowered && move.zBrokeProtect) {
			baseDamage = this.modify(baseDamage, 0.25);
			this.add('-zbroken', target);
		}

		// Generation 6-7 moves the check for minimum 1 damage after the final modifier...
		if (this.gen !== 5 && !baseDamage) return 1;

		// ...but 16-bit truncation happens even later, and can truncate to 0
		return tr(baseDamage, 16);
	}

	randomizer(baseDamage: number) {
		const tr = this.trunc;
		return tr(tr(baseDamage * (100 - this.random(16))) / 100);
	}

	/**
	 * Returns whether a proposed target for a move is valid.
	 */
	validTargetLoc(targetLoc: number, source: Pokemon, targetType: string) {
		if (targetLoc === 0) return true;
		let numSlots = source.side.active.length;
		if (!Math.abs(targetLoc) && Math.abs(targetLoc) > numSlots) return false;

		let sourceLoc = -(source.position + 1);
		let isFoe = (targetLoc > 0);
		let isAdjacent = (isFoe ? Math.abs(-(numSlots + 1 - targetLoc) - sourceLoc) <= 1 : Math.abs(targetLoc - sourceLoc) === 1);
		let isSelf = (sourceLoc === targetLoc);

		switch (targetType) {
		case 'randomNormal':
		case 'scripted':
		case 'normal':
			return isAdjacent;
		case 'adjacentAlly':
			return isAdjacent && !isFoe;
		case 'adjacentAllyOrSelf':
			return isAdjacent && !isFoe || isSelf;
		case 'adjacentFoe':
			return isAdjacent && isFoe;
		case 'any':
			return !isSelf;
		}
		return false;
	}

	getTargetLoc(target: Pokemon, source: Pokemon) {
		if (target.side === source.side) {
			return -(target.position + 1);
		} else {
			return target.position + 1;
		}
	}

	validTarget(target: Pokemon, source: Pokemon, targetType: string) {
		return this.validTargetLoc(this.getTargetLoc(target, source), source, targetType);
	}

	getTarget(pokemon: Pokemon, move: string | Move, targetLoc: number) {
		move = this.getMove(move);
		let target;
		// Fails if the target is the user and the move can't target its own position
		if (['adjacentAlly', 'any', 'normal'].includes(move.target) && targetLoc === -(pokemon.position + 1) &&
				!pokemon.volatiles['twoturnmove'] && !pokemon.volatiles['iceball'] && !pokemon.volatiles['rollout']) {
			if (move.isFutureMove) return pokemon;
			return null;
		}
		if (move.target !== 'randomNormal' && this.validTargetLoc(targetLoc, pokemon, move.target)) {
			if (targetLoc > 0) {
				target = pokemon.side.foe.active[targetLoc - 1];
			} else {
				target = pokemon.side.active[-targetLoc - 1];
			}
			if (target) {
				if (!target.fainted) {
					// target exists and is not fainted
					return target;
				} else if (target.side === pokemon.side) {
					// fainted allied targets don't retarget
					return null;
				}
			}
			// chosen target not valid, retarget randomly with resolveTarget
		}
		return this.resolveTarget(pokemon, move);
	}

	resolveTarget(pokemon: Pokemon, move: string | Move) {
		// A move was used without a chosen target

		// For instance: Metronome chooses Ice Beam. Since the user didn't
		// choose a target when choosing Metronome, Ice Beam's target must
		// be chosen randomly.

		// The target is chosen randomly from possible targets, EXCEPT that
		// moves that can target either allies or foes will only target foes
		// when used without an explicit target.

		move = this.getMove(move);
		if (move.target === 'adjacentAlly') {
			let allyActives = pokemon.side.active;
			let adjacentAllies = [allyActives[pokemon.position - 1], allyActives[pokemon.position + 1]];
			adjacentAllies = adjacentAllies.filter(active => active && !active.fainted);
			if (adjacentAllies.length) return this.sample(adjacentAllies);
			return null;
		}
		if (move.target === 'self' || move.target === 'all' || move.target === 'allySide' ||
				move.target === 'allyTeam' || move.target === 'adjacentAllyOrSelf') {
			return pokemon;
		}
		if (pokemon.side.active.length > 2) {
			if (move.target === 'adjacentFoe' || move.target === 'normal' || move.target === 'randomNormal') {
				// even if a move can target an ally, auto-resolution will never make it target an ally
				// i.e. if both your opponents faint before you use Flamethrower, it will fail instead of targeting your all
				let foeActives = pokemon.side.foe.active;
				let frontPosition = foeActives.length - 1 - pokemon.position;
				let adjacentFoes = foeActives.slice(frontPosition < 1 ? 0 : frontPosition - 1, frontPosition + 2);
				adjacentFoes = adjacentFoes.filter(active => active && !active.fainted);
				if (adjacentFoes.length) return this.sample(adjacentFoes);
				// no valid target at all, return a foe for any possible redirection
			}
		}
		return pokemon.side.foe.randomActive() || pokemon.side.foe.active[0];
	}

	checkFainted() {
		for (const pokemon of this.p1.active) {
			if (pokemon.fainted) {
				pokemon.status = 'fnt';
				pokemon.switchFlag = true;
			}
		}
		for (const pokemon of this.p2.active) {
			if (pokemon.fainted) {
				pokemon.status = 'fnt';
				pokemon.switchFlag = true;
			}
		}
	}

	faintMessages(lastFirst: boolean = false) {
		if (this.ended) return;
		if (!this.faintQueue.length) return false;
		if (lastFirst) {
			this.faintQueue.unshift(this.faintQueue[this.faintQueue.length - 1]);
			this.faintQueue.pop();
		}
		let faintData;
		while (this.faintQueue.length) {
			faintData = this.faintQueue[0];
			this.faintQueue.shift();
			if (!faintData.target.fainted && this.runEvent('BeforeFaint', faintData.target, faintData.source, faintData.effect)) {
				this.add('faint', faintData.target);
				faintData.target.side.pokemonLeft--;
				this.runEvent('Faint', faintData.target, faintData.source, faintData.effect);
				this.singleEvent('End', this.getAbility(faintData.target.ability), faintData.target.abilityData, faintData.target);
				faintData.target.clearVolatile(false);
				faintData.target.fainted = true;
				faintData.target.isActive = false;
				faintData.target.isStarted = false;
				faintData.target.side.faintedThisTurn = true;
				// SGgame
				if (this.getFormat().useSGgame && !this.getFormat().noExp && ((faintData.source && faintData.source.side.name !== 'SG Server') || faintData.target.side.name === 'SG Server')) {
					// Award Experience
					// If the source of the KO is a falsey value, use the current foe for calculating EXP. This can happen with things such as sandstorm.
					if (!faintData.source) faintData.source = this[faintData.target.side.foe.id].pokemon[0];
					let out = Server.onFaint(faintData.source.side.name, this, faintData);
					this.send('updateExp', out.substring(0, out.length - 1));
				}
			}
		}

		if (this.gen <= 1) {
			// in gen 1, fainting skips the rest of the turn
			// residuals don't exist in gen 1
			this.queue = [];
		} else if (this.gen <= 3 && this.gameType === 'singles') {
			// in gen 3 or earlier, fainting in singles skips to residuals
			for (const side of this.sides) {
				for (const pokemon of side.active) {
					if (this.gen <= 2) {
						// in gen 2, fainting skips moves only
						this.cancelMove(pokemon);
					} else {
						// in gen 3, fainting skips all moves and switches
						this.cancelAction(pokemon);
					}
				}
			}
		}

		if (!this.p1.pokemonLeft && !this.p2.pokemonLeft) {
			this.win(faintData ? faintData.target.side : null);
			return true;
		}
		if (!this.p1.pokemonLeft) {
			this.win(this.p2);
			return true;
		}
		if (!this.p2.pokemonLeft) {
			this.win(this.p1);
			return true;
		}
		return false;
	}

	/**
	 * Takes an object describing an action, and fills it out into a full
	 * Action object.
	 */
	resolveAction(action: AnyObject, midTurn: boolean = false): Actions["Action"] {
		if (!action) throw new Error(`Action not passed to resolveAction`);

		if (!action.side && action.pokemon) action.side = action.pokemon.side;
		if (!action.move && action.moveid) action.move = this.getActiveMove(action.moveid);
		if (!action.choice && action.move) action.choice = 'move';
		if (!action.priority && action.priority !== 0) {
			let priorities = {
				'beforeTurn': 100,
				'beforeTurnMove': 99,
				'pokeball': 98,
				'useItem': 97,
				'switch': 7,
				'runUnnerve': 7.3,
				'runSwitch': 7.2,
				'runPrimal': 7.1,
				'instaswitch': 101,
				'megaEvo': 6.9,
				'residual': -100,
				'team': 102,
				'start': 101,
			};
			if (action.choice in priorities) {
				// @ts-ignore
				action.priority = priorities[action.choice];
			}
		}
		if (!midTurn) {
			if (action.choice === 'move') {
				if (!action.zmove && action.move.beforeTurnCallback) {
					this.addToQueue({choice: 'beforeTurnMove', pokemon: action.pokemon, move: action.move, targetLoc: action.targetLoc});
				}
				if (action.mega) {
					// TODO: Check that the Pokémon is not affected by Sky Drop.
					// (This is currently being done in `runMegaEvo`).
					this.addToQueue({
						choice: 'megaEvo',
						pokemon: action.pokemon,
					});
				}
			} else if (action.choice === 'switch' || action.choice === 'instaswitch') {
				if (typeof action.pokemon.switchFlag === 'string') {
					action.sourceEffect = this.getEffect(action.pokemon.switchFlag);
				}
				action.pokemon.switchFlag = false;
				if (!action.speed) action.speed = action.pokemon.getActionSpeed();
			}
		}

		let deferPriority = this.gen >= 7 && action.mega && action.mega !== 'done';
		if (action.move) {
			let target = null;
			action.move = this.getActiveMove(action.move);

			if (!action.targetLoc) {
				target = this.resolveTarget(action.pokemon, action.move);
				// TODO: what actually happens here?
				if (target) action.targetLoc = this.getTargetLoc(target, action.pokemon);
			}

			if (!action.priority && !deferPriority) {
				let move = action.move;
				if (action.zmove) {
					let zMoveName = this.getZMove(action.move, action.pokemon, true);
					if (zMoveName) {
						let zMove = this.getActiveMove(zMoveName);
						if (zMove.exists && zMove.isZ) {
							move = zMove;
						}
					}
				}
				let priority = this.runEvent('ModifyPriority', action.pokemon, target, move, move.priority);
				action.priority = priority;
				// In Gen 6, Quick Guard blocks moves with artificially enhanced priority.
				if (this.gen > 5) action.move.priority = priority;
			}
		}
		if (!action.speed) {
			if ((action.choice === 'switch' || action.choice === 'instaswitch') && action.target) {
				action.speed = action.target.getActionSpeed();
			} else if (!action.pokemon) {
				action.speed = 1;
			} else if (!deferPriority) {
				action.speed = action.pokemon.getActionSpeed();
			}
		}
		return action as any;
	}

	/**
	 * Adds the action last in the queue. Mostly used before sortQueue.
	 */
	addToQueue(action: AnyObject | AnyObject[]) {
		if (Array.isArray(action)) {
			for (const curAction of action) {
				this.addToQueue(curAction);
			}
			return;
		}

		if (action.choice === 'pass') return;
		this.queue.push(this.resolveAction(action));
	}

	sortQueue() {
		this.speedSort(this.queue);
	}

	/**
	 * Inserts the passed action into the action queue when it normally
	 * would have happened (sorting by priority/speed), without
	 * re-sorting the existing actions.
	 */
	insertQueue(chosenAction: AnyObject | AnyObject[], midTurn: boolean = false) {
		if (Array.isArray(chosenAction)) {
			for (const subAction of chosenAction) {
				this.insertQueue(subAction);
			}
			return;
		}

		if (chosenAction.pokemon) chosenAction.pokemon.updateSpeed();
		const action = this.resolveAction(chosenAction, midTurn);
		for (const [i, curAction] of this.queue.entries()) {
			if (this.comparePriority(action, curAction) < 0) {
				this.queue.splice(i, 0, action);
				return;
			}
		}
		this.queue.push(action);
	}

	/**
	 * Makes the passed action happen next (skipping speed order).
	 */
	prioritizeAction(action: Actions["MoveAction"] | Actions["SwitchAction"], source?: Pokemon, sourceEffect?: Effect) {
		if (this.event) {
			if (!sourceEffect) sourceEffect = this.effect;
		}
		for (const [i, curAction] of this.queue.entries()) {
			if (curAction === action) {
				this.queue.splice(i, 1);
				break;
			}
		}
		action.sourceEffect = sourceEffect;
		this.queue.unshift(action);
	}

	willAct() {
		for (const action of this.queue) {
			if (action.choice === 'move' || action.choice === 'switch' || action.choice === 'instaswitch' || action.choice === 'shift') {
				return action;
			}
		}
		return null;
	}

	willMove(pokemon: Pokemon) {
		if (pokemon.fainted) return false;
		for (const action of this.queue) {
			if (action.choice === 'move' && action.pokemon === pokemon) {
				return action;
			}
		}
		return null;
	}

	cancelAction(pokemon: Pokemon) {
		let success = false;
		this.queue = this.queue.filter(action => {
			if (action.pokemon === pokemon && action.priority >= -100) {
				success = true;
				return false;
			}
			return true;
		});
		return success;
	}

	cancelMove(pokemon: Pokemon) {
		for (const [i, action] of this.queue.entries()) {
			if (action.choice === 'move' && action.pokemon === pokemon) {
				this.queue.splice(i, 1);
				return true;
			}
		}
		return false;
	}

	willSwitch(pokemon: Pokemon) {
		for (const action of this.queue) {
			if ((action.choice === 'switch' || action.choice === 'instaswitch') && action.pokemon === pokemon) {
				return action;
			}
		}
		return false;
	}

	runAction(action: Actions["Action"]) {
		// returns whether or not we ended in a callback
		switch (action.choice) {
		case 'start': {
			// I GIVE UP, WILL WRESTLE WITH EVENT SYSTEM LATER
			let format = this.getFormat();

			// Remove Pokémon duplicates remaining after `team` decisions.
			this.p1.pokemon = this.p1.pokemon.slice(0, this.p1.pokemonLeft);
			this.p2.pokemon = this.p2.pokemon.slice(0, this.p2.pokemonLeft);

			if (format.teamLength && format.teamLength.battle) {
				// Trim the team: not all of the Pokémon brought to Preview will battle.
				this.p1.pokemon = this.p1.pokemon.slice(0, format.teamLength.battle);
				this.p1.pokemonLeft = this.p1.pokemon.length;
				this.p2.pokemon = this.p2.pokemon.slice(0, format.teamLength.battle);
				this.p2.pokemonLeft = this.p2.pokemon.length;
			}

			this.add('start');
			for (let pos = 0; pos < this.p1.active.length; pos++) {
				this.switchIn(this.p1.pokemon[pos], pos);
			}
			for (let pos = 0; pos < this.p2.active.length; pos++) {
				this.switchIn(this.p2.pokemon[pos], pos);
			}
			for (const pokemon of this.p1.pokemon) {
				this.singleEvent('Start', this.getEffect(pokemon.species), pokemon.speciesData, pokemon);
			}
			for (const pokemon of this.p2.pokemon) {
				this.singleEvent('Start', this.getEffect(pokemon.species), pokemon.speciesData, pokemon);
			}
			this.midTurn = true;
			break;
		}

		case 'move':
			if (!action.pokemon.isActive) return false;
			if (action.pokemon.fainted) return false;
			this.runMove(action.move, action.pokemon, action.targetLoc, action.sourceEffect, action.zmove);
			break;
		case 'megaEvo':
			this.runMegaEvo(action.pokemon);
			break;
		case 'beforeTurnMove': {
			if (!action.pokemon.isActive) return false;
			if (action.pokemon.fainted) return false;
			this.debug('before turn callback: ' + action.move.id);
			let target = this.getTarget(action.pokemon, action.move, action.targetLoc);
			if (!target) return false;
			if (!action.move.beforeTurnCallback) throw new Error(`beforeTurnMove has no beforeTurnCallback`);
			action.move.beforeTurnCallback.call(this, action.pokemon, target);
			break;
		}

		case 'event':
			// @ts-ignore Easier than defining a custom event attribute tbh
			this.runEvent(action.event, action.pokemon);
			break;
		case 'team': {
			action.pokemon.side.pokemon.splice(action.index, 0, action.pokemon);
			action.pokemon.position = action.index;
			// we return here because the update event would crash since there are no active pokemon yet
			return;
		}

		// SGgame
		case 'pokeball':
			this.add('message', `${action.side.name} threw a ${(action.ball.charAt(0).toUpperCase() + action.ball.slice(1))}!`);
			let result = Server.throwPokeball(action.ball, action.target);
			let count = result;
			if (count === true) count = 3;
			let msgs = ['Oh no! The pokemon broke free', 'Aww! It appeared to be caught!', 'Aargh! Almost had it!', 'Gah! It was so close too!', 'Gotcha! ' + (action.target.name || action.target.species) + ' was caught!'];
			for (count; count > 0; count--) {
				this.add('message', '...');
			}
			this.send('takeitem', toId(action.side.name) + '|' + action.ball + '|' + action.side.active[0].slot);
			if (result === true) {
				this.add('message', msgs[msgs.length - 1]);
				// Giving the newly caught pokemon handled in the main process.
				this.send('caught', toId(action.side.name) + '|' + action.ball);
				if (this.getFormat().useSGgame && !this.getFormat().noExp && action.side.name !== 'SG Server') {
					// Award Experience
					let out = Server.onFaint(toId(action.side.name), this, {source: action.side.active[0], target: action.target});
					this.send('updateExp', out.substring(0, out.length - 1));
				}
				this.win(action.side);
				return true;
			} else {
				this.add('message', msgs[result]);
				this.add('');
			}
			break;
		case 'useItem':
			let hadEffect = false;
			if (action.item.use.healHP) {
				let heal = 0;
				if (typeof action.item.use.healHP === 'string') {
					heal = action.target.maxhp * (Number(action.item.use.healHP.substring(0, action.item.use.healHP.length - 1)) * 0.01);
				} else if (action.item.use.healHP === true) {
					heal = action.target.maxhp - action.target.hp;
				} else {
					heal = action.item.use.healHP;
				}
				if (action.target.hp + heal > action.target.maxhp) heal = action.target.maxhp - action.target.hp;
				if (heal > 0) {
					this.heal(heal, action.target, null, {fullname: action.item.name});
					hadEffect = true;
				}
			}
			if (action.item.use.healStatus) {
				if (action.target.status || action.target.volatiles['confusion']) {
					if (action.item.use.healStatus === true) {
						action.target.cureStatus();
						action.target.removeVolatile('confusion');
						hadEffect = true;
					} else {
						let canHeal = action.item.use.healStatus.split('|');
						if (canHeal.indexOf(action.target.status) > -1) {
							action.target.cureStatus();
							hadEffect = true;
						}
						if (canHeal.indexOf('confusion') > -1 && ('confusion' in action.target.volatiles)) {
							action.target.removeVolatile('confusion');
							hadEffect = true;
						}
					}
				}
			}
			if (action.item.use.healPP) {
				let move = action.target.moveset[action.move];
				if (move.pp < move.maxpp) {
					move.pp += action.item.use.healPP;
					if (move.pp > move.maxpp) move.pp = move.maxpp;
					hadEffect = true;
					this.add('', (action.target.name || action.target.species) + "'s " + move.id + " had its PP restored by " + action.item.use.healPP + "!");
				}
			}
			if (hadEffect) {
				this.add('message', action.side.name + " used a " + action.item.name + "!");
				this.send('takeitem', toId(action.side.name) + "|" + action.item.id + "|" + action.target.slot);
				this.add('');
			}
			break;

		case 'pass':
			return;
		case 'instaswitch':
		case 'switch':
			if (action.choice === 'switch' && action.pokemon.status && this.data.Abilities.naturalcure) {
				this.singleEvent('CheckShow', this.getAbility('naturalcure'), null, action.pokemon);
			}
			if (action.pokemon.hp) {
				action.pokemon.beingCalledBack = true;
				const sourceEffect = action.sourceEffect;
				// @ts-ignore
				if (sourceEffect && sourceEffect.selfSwitch === 'copyvolatile') {
					action.pokemon.switchCopyFlag = true;
				}
				if (!action.pokemon.switchCopyFlag) {
					this.runEvent('BeforeSwitchOut', action.pokemon);
					if (this.gen >= 5) {
						this.eachEvent('Update');
					}
				}
				if (!this.runEvent('SwitchOut', action.pokemon)) {
					// Warning: DO NOT interrupt a switch-out
					// if you just want to trap a pokemon.
					// To trap a pokemon and prevent it from switching out,
					// (e.g. Mean Look, Magnet Pull) use the 'trapped' flag
					// instead.

					// Note: Nothing in BW or earlier interrupts
					// a switch-out.
					break;
				}
			}
			action.pokemon.illusion = null;
			this.singleEvent('End', this.getAbility(action.pokemon.ability), action.pokemon.abilityData, action.pokemon);
			if (!action.pokemon.hp && !action.pokemon.fainted) {
				// a pokemon fainted from Pursuit before it could switch
				if (this.gen <= 4) {
					// in gen 2-4, the switch still happens
					action.priority = -101;
					this.queue.unshift(action);
					this.hint("Previously chosen switches continue in Gen 2-4 after a Pursuit target faints.");
					break;
				}
				// in gen 5+, the switch is cancelled
				this.debug('A Pokemon can\'t switch between when it runs out of HP and when it faints');
				break;
			}
			if (action.target.isActive) {
				this.hint("A switch failed because the Pokémon trying to switch in is already in.");
				break;
			}
			if (action.choice === 'switch' && action.pokemon.activeTurns === 1) {
				for (const foeActive of action.pokemon.side.foe.active) {
					if (foeActive.isStale >= 2) {
						action.pokemon.isStaleCon++;
						action.pokemon.isStaleSource = 'switch';
						break;
					}
				}
			}

			this.switchIn(action.target, action.pokemon.position, action.sourceEffect);
			break;
		case 'runUnnerve':
			this.singleEvent('PreStart', action.pokemon.getAbility(), action.pokemon.abilityData, action.pokemon);
			break;
		case 'runSwitch':
			this.runEvent('SwitchIn', action.pokemon);
			if (this.gen <= 2 && !action.pokemon.side.faintedThisTurn && action.pokemon.draggedIn !== this.turn) {
				this.runEvent('AfterSwitchInSelf', action.pokemon);
			}
			if (!action.pokemon.hp) break;
			action.pokemon.isStarted = true;
			if (!action.pokemon.fainted) {
				this.singleEvent('Start', action.pokemon.getAbility(), action.pokemon.abilityData, action.pokemon);
				action.pokemon.abilityOrder = this.abilityOrder++;
				this.singleEvent('Start', action.pokemon.getItem(), action.pokemon.itemData, action.pokemon);
			}
			if (this.gen === 4) {
				for (const foeActive of action.pokemon.side.foe.active) {
					foeActive.removeVolatile('substitutebroken');
				}
			}
			delete action.pokemon.draggedIn;
			break;
		case 'runPrimal':
			if (!action.pokemon.transformed) this.singleEvent('Primal', action.pokemon.getItem(), action.pokemon.itemData, action.pokemon);
			break;
		case 'shift': {
			if (!action.pokemon.isActive) return false;
			if (action.pokemon.fainted) return false;
			action.pokemon.activeTurns--;
			this.swapPosition(action.pokemon, 1);
			for (const foeActive of action.pokemon.side.foe.active) {
				if (foeActive.isStale >= 2) {
					action.pokemon.isStaleCon++;
					action.pokemon.isStaleSource = 'switch';
					break;
				}
			}
			break;
		}

		case 'beforeTurn':
			this.eachEvent('BeforeTurn');
			break;
		case 'residual':
			this.add('');
			this.clearActiveMove(true);
			this.updateSpeed();
			this.residualEvent('Residual');
			this.add('upkeep');
			break;
		}

		// phazing (Roar, etc)
		for (const pokemon of this.p1.active) {
			if (pokemon.forceSwitchFlag) {
				if (pokemon.hp) this.dragIn(pokemon.side, pokemon.position);
				pokemon.forceSwitchFlag = false;
			}
		}
		for (const pokemon of this.p2.active) {
			if (pokemon.forceSwitchFlag) {
				if (pokemon.hp) this.dragIn(pokemon.side, pokemon.position);
				pokemon.forceSwitchFlag = false;
			}
		}

		this.clearActiveMove();

		// fainting

		this.faintMessages();
		if (this.ended) return true;

		// switching (fainted pokemon, U-turn, Baton Pass, etc)

		if (!this.queue.length || (this.gen <= 3 && ['move', 'residual'].includes(this.queue[0].choice))) {
			// in gen 3 or earlier, switching in fainted pokemon is done after
			// every move, rather than only at the end of the turn.
			this.checkFainted();
		} else if (action.choice === 'megaEvo' && this.gen >= 7) {
			this.eachEvent('Update');
			// In Gen 7, the action order is recalculated for a Pokémon that mega evolves.
			const moveIndex = this.queue.findIndex(queuedAction => queuedAction.pokemon === action.pokemon && queuedAction.choice === 'move');
			if (moveIndex >= 0) {
				const moveAction = this.queue.splice(moveIndex, 1)[0] as Actions["MoveAction"];
				moveAction.mega = 'done';
				this.insertQueue(moveAction, true);
			}
			return false;
		} else if (this.queue.length && this.queue[0].choice === 'instaswitch') {
			return false;
		}

		let p1switch = this.p1.active.some(mon => mon && !!mon.switchFlag);
		let p2switch = this.p2.active.some(mon => mon && !!mon.switchFlag);

		if (p1switch && !this.canSwitch(this.p1)) {
			for (const pokemon of this.p1.active) {
				pokemon.switchFlag = false;
			}
			p1switch = false;
		}
		if (p2switch && !this.canSwitch(this.p2)) {
			for (const pokemon of this.p2.active) {
				pokemon.switchFlag = false;
			}
			p2switch = false;
		}

		if (p1switch || p2switch) {
			if (this.gen >= 5) {
				this.eachEvent('Update');
			}
			this.makeRequest('switch');
			return true;
		}

		this.eachEvent('Update');

		return false;
	}

	go() {
		this.add('');
		if (this.currentRequest) {
			this.currentRequest = '';
		}

		if (!this.midTurn) {
			this.queue.push(this.resolveAction({choice: 'residual'}));
			this.queue.unshift(this.resolveAction({choice: 'beforeTurn'}));
			this.midTurn = true;
		}

		while (this.queue.length) {
			let action = this.queue[0];
			this.queue.shift();

			this.runAction(action);

			if (this.currentRequest) {
				return;
			}

			if (this.ended) return;
		}

		this.nextTurn();
		this.midTurn = false;
		this.queue = [];
	}

	/**
	 * Changes a pokemon's action, and inserts its new action
	 * in priority order.
	 *
	 * You'd normally want the OverrideAction event (which doesn't
	 * change priority order).
	 */
	changeAction(pokemon: Pokemon, action: AnyObject) {
		this.cancelAction(pokemon);
		if (!action.pokemon) action.pokemon = pokemon;
		this.insertQueue(action);
	}

	/**
	 * Takes a choice string passed from the client. Starts the next
	 * turn if all required choices have been made.
	 */
	choose(sideid: string, input: string) {
		let side = null;
		if (sideid === 'p1' || sideid === 'p2') side = this[sideid];
		if (!side) throw new Error(`Invalid side ${sideid}`);

		if (!side.choose(input)) return false;

		if (!side.isChoiceDone()) {
			side.emitChoiceError(`Incomplete choice: ${input} - missing other pokemon`);
			return false;
		}
		this.checkActions();
		return true;
	}

	/**
	 * Convenience method for easily making choices.
	 */
	makeChoices(...inputs: string[]) {
		for (const [i, input] of inputs.entries()) {
			this.sides[i].choose(input);
		}
		this.commitDecisions();
	}

	commitDecisions() {
		this.updateSpeed();

		let oldQueue = this.queue;
		this.queue = [];
		for (const side of this.sides) {
			side.autoChoose();
		}
		let p1choice = this.p1.getChoice();
		if (p1choice) this.inputLog.push(`>p1 ${p1choice}`);
		let p2choice = this.p2.getChoice();
		if (p2choice) this.inputLog.push(`>p2 ${p2choice}`);
		for (const side of this.sides) {
			this.addToQueue(side.choice.actions);
		}

		this.sortQueue();
		Array.prototype.push.apply(this.queue, oldQueue);

		this.currentRequest = '';
		this.p1.currentRequest = '';
		this.p2.currentRequest = '';

		this.go();
	}

	undoChoice(sideid: string) {
		let side = null;
		if (sideid === 'p1' || sideid === 'p2') side = this[sideid];
		if (!side) throw new Error(`Invalid side ${sideid}`);
		if (!side.currentRequest) return;

		if (side.choice.cantUndo) {
			side.emitChoiceError(`Can't undo: A trapping/disabling effect would cause undo to leak information`);
			return;
		}

		side.clearChoice();
	}

	/**
	 * returns true if both decisions are complete
	 */
	checkActions() {
		let totalActions = 0;
		if (this.p1.isChoiceDone()) {
			if (!this.supportCancel) this.p1.choice.cantUndo = true;
			totalActions++;
		}
		if (this.p2.isChoiceDone()) {
			if (!this.supportCancel) this.p2.choice.cantUndo = true;
			totalActions++;
		}
		if (totalActions >= this.sides.length) {
			this.commitDecisions();
			return true;
		}
		return false;
	}

	hint(hint: string, once?: boolean, side?: Side) {
		if (this.hints.has(hint)) return;

		if (side) {
			this.add('split');
			for (const line of [false, this.sides[0], this.sides[1], true]) {
				if (line === true || line === side) {
					this.add('-hint', hint);
				} else {
					this.log.push('');
				}
			}
		} else {
			this.add('-hint', hint);
		}

		if (once) this.hints.add(hint);
	}

	add(...parts: (string | number | boolean | ((side: Side | boolean) => string) | AnyObject | null | undefined)[]) {
		if (!parts.some(part => typeof part === 'function')) {
			this.log.push(`|${parts.join('|')}`);
			return;
		}
		if (this.reportExactHP) {
			parts = parts.map(part => {
				if (typeof part !== 'function') return part;
				// @ts-ignore
				return part(true);
			});
			this.log.push(`|${parts.join('|')}`);
			return;
		}
		this.log.push('|split');
		let sides: (Side | boolean)[] = [false, this.sides[0], this.sides[1], true];
		for (const side of sides) {
			let sideUpdate = '|' + parts.map(part => {
				if (typeof part !== 'function') return part;
				// @ts-ignore
				return part(side);
			}).join('|');
			this.log.push(sideUpdate);
		}
	}

	// tslint:disable-next-line:ban-types
	addMove(...args: (string | number | Function | AnyObject)[]) {
		this.lastMoveLine = this.log.length;
		this.log.push(`|${args.join('|')}`);
	}

	// tslint:disable-next-line:ban-types
	attrLastMove(...args: (string | number | Function | AnyObject)[]) {
		if (this.lastMoveLine < 0) return;
		if (this.log[this.lastMoveLine].startsWith('|-anim|')) {
			if (args.includes('[still]')) {
				this.log.splice(this.lastMoveLine, 1);
				this.lastMoveLine = -1;
				return;
			}
		} else if (args.includes('[still]')) {
			// If no animation plays, the target should never be known
			let parts = this.log[this.lastMoveLine].split('|');
			parts[4] = '';
			this.log[this.lastMoveLine] = parts.join('|');
		}
		this.log[this.lastMoveLine] += `|${args.join('|')}`;
	}

	retargetLastMove(newTarget: Pokemon) {
		if (this.lastMoveLine < 0) return;
		let parts = this.log[this.lastMoveLine].split('|');
		parts[4] = newTarget.toString();
		this.log[this.lastMoveLine] = parts.join('|');
	}

	debug(activity: string) {
		if (this.debugMode) {
			this.add('debug', activity);
		}
	}

	getDebugLog() {
		return this.log.join('\n').replace(/\|split\n.*\n.*\n.*\n/g, '');
	}

	debugError(activity: string) {
		this.add('debug', activity);
	}

	// players

	getTeam(team: PokemonSet[] | string | null): PokemonSet[] {
		const format = this.getFormat();
		if (typeof team === 'string') team = Dex.fastUnpackTeam(team);
		if (!format.team && team) {
			return team;
		}

		if (!this.teamGenerator) {
			this.teamGenerator = this.getTeamGenerator(format, this.prng);
		}
		team = this.teamGenerator.generateTeam();

		return team as PokemonSet[];
	}

	setPlayer(slot: 'p1' | 'p2', options: PlayerOptions) {
		let side;
		let didSomething = true;
		if (!this[slot]) {
			// create player
			const slotNum = (slot === 'p2' ? 1 : 0);
			const team = this.getTeam(options.team || null);
			side = new Side(options.name || `Player ${slotNum + 1}`, this, slotNum, team);
			if (options.avatar) side.avatar = '' + options.avatar;
			this[slot] = side;
			this.sides[slotNum] = side;
		} else {
			// edit player
			side = this[slot];
			didSomething = false;
			if (options.name && side.name !== options.name) {
				side.name = options.name;
				didSomething = true;
			}
			if (options.avatar && side.avatar !== '' + options.avatar) {
				side.avatar = '' + options.avatar;
				didSomething = true;
			}
			if (options.team) throw new Error(`Player ${slot} already has a team!`);
		}
		if (options.team && typeof options.team !== 'string') {
			options.team = this.packTeam(options.team);
		}
		if (!didSomething) return;
		this.inputLog.push(`>player ${slot} ` + JSON.stringify(options));
		this.add('player', side.id, side.name, side.avatar);
		this.start();
	}

	/** @deprecated */
	join(slot: 'p1' | 'p2', name: string, avatar: string, team: PokemonSet[] | string | null) {
		this.setPlayer(slot, {
			name,
			avatar,
			team,
		});

		return this[slot];
	}

	sendUpdates() {
		if (this.sentLogPos >= this.log.length) return;
		this.send('update', this.log.slice(this.sentLogPos));
		this.sentLogPos = this.log.length;

		if (!this.sentEnd && this.ended) {
			let log = {
				winner: this.winner,
				seed: this.prngSeed,
				turns: this.turn,
				p1: this.p1.name,
				p2: this.p2.name,
				p1team: this.p1.team,
				p2team: this.p2.team,
				score: [this.p1.pokemonLeft, this.p2.pokemonLeft],
				inputLog: this.inputLog,
			};
			this.send('end', JSON.stringify(log));
			this.sentEnd = true;
		}
	}

	runMove(move: string | Move, target: Pokemon, targetLoc?: number, sourceEffect?: Effect | null, zMove?: string, externalMove?: boolean) {
		throw new Error(`The runMove function needs to be implemented in scripts.js or the battle format.`);
	}

	useMove(move: string | Move, pokemon: Pokemon, target?: Pokemon | null, sourceEffect?: Effect | null, zMove?: string): boolean {
		throw new Error(`The useMove function needs to be implemented in scripts.js or the battle format.`);
	}

	/**
	 * target = undefined: automatically resolve target
	 * target = null: no target (move will fail)
	 */
	useMoveInner(move: string | Move, pokemon: Pokemon, target?: Pokemon | null, sourceEffect?: Effect | null, zMove?: string): boolean {
		throw new Error(`The useMoveInner function needs to be implemented in scripts.js or the battle format.`);
	}

	tryMoveHit(target: Pokemon, pokemon: Pokemon, move: Move): number | undefined | false | '' {
		throw new Error(`The tryMoveHit function needs to be implemented in scripts.js or the battle format.`);
	}

	moveHit(
		target: Pokemon | null, pokemon: Pokemon, move: string | Move,
		moveData?: ActiveMove | SelfEffect | SecondaryEffect, isSecondary?: boolean, isSelf?: boolean): number | undefined | false {
		throw new Error(`The tryMoveHit function needs to be implemented in scripts.js or the battle format.`);
	}

	calcRecoilDamage(damage: any, move: Move): number {
		throw new Error(`The calcRecoilDamage function needs to be implemented in scripts.js or the battle format.`);
	}

	canZMove(pokemon: Pokemon): (AnyObject | null)[] | void {
		throw new Error(`The canZMove function needs to be implemented in scripts.js or the battle format.`);
	}

	canUltraBurst(pokemon: Pokemon): string | null {
		throw new Error(`The canUltraBurst function needs to be implemented in scripts.js or the battle format.`);
	}

	canMegaEvo(pokemon: Pokemon): string | null | undefined {
		throw new Error(`The canMegaEvo function needs to be implemented in scripts.js or the battle format.`);
	}

	/**
	 * This function is also used for Ultra Bursting.
	 * Takes the Pokemon that will Mega Evolve or Ultra Burst as a parameter.
	 * Returns false if the Pokemon cannot Mega Evolve or Ultra Burst, otherwise returns true.
	 */
	runMegaEvo(pokemon: Pokemon): boolean {
		throw new Error(`The runMegaEvo function needs to be implemented in scripts.js or the battle format.`);
	}

	getZMove(move: Move, pokemon: Pokemon, skipChecks?: boolean): string | undefined {
		throw new Error(`The getZMove function needs to be implemented in scripts.js or the battle format.`);
	}

	getActiveZMove(move: string | Move, pokemon: Pokemon): ActiveMove {
		throw new Error(`The getActiveZMove function needs to be implemented in scripts.js or the battle format.`);
	}

	runZPower(move: ActiveMove, pokemon: Pokemon) {
		throw new Error(`The runZPower function needs to be implemented in scripts.js or the battle format.`);
	}

	isAdjacent(pokemon: Pokemon, target: Pokemon): boolean {
		throw new Error(`The isAdjacent function needs to be implemented in scripts.js or the battle format.`);
	}

	targetTypeChoices(targetType: string): boolean {
		throw new Error(`The targetTypeChoices function needs to be implemented in scripts.js or the battle format.`);
	}

	destroy() {
		// deallocate ourself

		// deallocate children and get rid of references to them
		for (const side of this.sides) {
			if (side) side.destroy();
		}
		// @ts-ignore - prevent type | null
		this.p1 = null;
		// @ts-ignore - prevent type | null
		this.p2 = null;
		for (const action of this.queue) {
			delete action.pokemon;
		}
		this.queue = [];

		// in case the garbage collector really sucks, at least deallocate the log
		this.log = [];
	}
}
