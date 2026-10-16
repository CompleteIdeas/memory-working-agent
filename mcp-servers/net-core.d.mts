// Types for net-core.mjs (BL-16c), so src/tools/net-guard.ts can import the shared guard.
import type { LookupFunction } from 'node:net';
export declare function isBlockedAddress(ip: string): boolean;
export declare function hostRefusal(u: URL, blocked?: (ip: string) => boolean): string | null;
export declare class BlockedAddressError extends Error { code: 'EMWABLOCKED'; constructor(host: string) }
export declare const guardedLookup: LookupFunction;
export declare function lookupGuardedBy(blocked: (ip: string) => boolean): LookupFunction;
export declare function pinnedFetch(url: string, init?: RequestInit, maxRedirects?: number, blocked?: (ip: string) => boolean): Promise<Response | string>;
