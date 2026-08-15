import EventEmitter from "node:events";
import type { LicenseEventMap } from "./types";

/**
 * A strongly-typed Event Emitter wrapper for the LicenseClient.
 * Exposes methods to subscribe to strictly defined events in `LicenseEventMap`.
 */
export class EventBroker {
	private emitter = new EventEmitter();

	constructor(private readonly onListenerError?: (error: unknown) => void) {}

	/**
	 * Subscribes to a given license event.
	 * @param event - The name of the event to listen for.
	 * @param listener - The callback function executed when the event fires.
	 */
	public on<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void {
		this.emitter.on(event, listener);
	}

	/**
	 * Subscribes to a given license event for a single execution.
	 * @param event - The name of the event to listen for.
	 * @param listener - The callback function executed when the event fires.
	 */
	public once<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void {
		this.emitter.once(event, listener);
	}

	/**
	 * Emits an event, triggering all registered listeners.
	 * Internal use only.
	 * @param event - The name of the event to emit.
	 * @param args - Strongly-typed arguments to pass to the listeners.
	 */
	public emit<K extends keyof LicenseEventMap>(
		event: K,
		...args: Parameters<LicenseEventMap[K]>
	): void {
		const listeners = this.emitter.rawListeners(event);
		for (const listener of listeners) {
			try {
				const typedListener = listener as (
					...listenerArgs: Parameters<LicenseEventMap[K]>
				) => unknown;
				typedListener.apply(this.emitter, args);
			} catch (error) {
				this.onListenerError?.(error);
			}
		}
	}

	/**
	 * Removes a specific listener from an event.
	 * @param event - The name of the event.
	 * @param listener - The callback function to remove.
	 */
	public removeListener<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void {
		this.emitter.removeListener(event, listener);
	}

	/**
	 * Removes all listeners across all events.
	 * Typically called during `LicenseClient.deactivate()`.
	 */
	public removeAllListeners(): void {
		this.emitter.removeAllListeners();
	}
}
