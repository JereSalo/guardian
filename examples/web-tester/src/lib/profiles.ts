import { AuthSecretKey } from '@miden-sdk/miden-sdk';
import { FalconSigner } from '@openzeppelin/miden-multisig-client';
import { logger } from './log';

const DB_NAME = 'multisig-tester-profiles';
const STORE = 'profiles';
const ACTIVE_KEY = 'multisig-tester-active-profile';
const log = logger('profiles');

export type ProfileRecord = {
  id: string;
  name: string;
  scheme: 'falcon';
  secretKeyBytes: Uint8Array;
  commitment: string;
  midenDbName: string;
  createdAt: number;
  // Last multisig accountId the user create-d or load-ed with this profile.
  // Used to auto-restore the multisig when the profile becomes active again
  // (e.g. after a profile switch or page reload).
  lastAccountId?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    Promise.resolve(fn(store)).then((value) => {
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }, reject);
  });
}

function uuid(): string {
  return (crypto as { randomUUID: () => string }).randomUUID();
}

export async function listProfiles(): Promise<ProfileRecord[]> {
  return tx('readonly', (store) => new Promise<ProfileRecord[]>((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as ProfileRecord[]).sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  }));
}

export async function getProfile(id: string): Promise<ProfileRecord | undefined> {
  return tx('readonly', (store) => new Promise<ProfileRecord | undefined>((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result as ProfileRecord | undefined);
    req.onerror = () => reject(req.error);
  }));
}

export async function createProfile(name: string): Promise<ProfileRecord> {
  const secretKey = AuthSecretKey.rpoFalconWithRNG(undefined);
  const signer = new FalconSigner(secretKey);
  const commitment = signer.commitment;
  const secretKeyBytes = secretKey.serialize();
  const id = uuid();
  const profile: ProfileRecord = {
    id,
    name,
    scheme: 'falcon',
    secretKeyBytes,
    commitment,
    midenDbName: `MidenClientDB_${id}`,
    createdAt: Date.now(),
  };
  await tx('readwrite', (store) => new Promise<void>((resolve, reject) => {
    const req = store.add(profile);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
  log.info('created profile', { id, name, commitment });
  return profile;
}

export async function updateProfile(id: string, patch: Partial<ProfileRecord>): Promise<ProfileRecord | undefined> {
  const existing = await getProfile(id);
  if (!existing) return undefined;
  const updated = { ...existing, ...patch, id: existing.id };
  await tx('readwrite', (store) => new Promise<void>((resolve, reject) => {
    const req = store.put(updated);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
  log.info('updated profile', { id, patch });
  return updated;
}

export async function deleteProfile(id: string): Promise<void> {
  const profile = await getProfile(id);
  if (!profile) return;
  await tx('readwrite', (store) => new Promise<void>((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
  // Delete the per-profile Miden client store too.
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(profile.midenDbName);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
    r.onblocked = () => resolve();
  });
  if (getActiveProfileId() === id) {
    setActiveProfileId(null);
  }
}

export function makeSignerFromProfile(profile: ProfileRecord): FalconSigner {
  const secretKey = AuthSecretKey.deserialize(profile.secretKeyBytes);
  return new FalconSigner(secretKey);
}

export function getActiveProfileId(): string | null {
  return sessionStorage.getItem(ACTIVE_KEY);
}

export function setActiveProfileId(id: string | null): void {
  if (id) sessionStorage.setItem(ACTIVE_KEY, id);
  else sessionStorage.removeItem(ACTIVE_KEY);
}
