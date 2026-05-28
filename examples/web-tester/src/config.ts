const STORAGE_KEY = 'multisig-tester-settings';

export type Settings = {
  guardianEndpoint: string;
  midenRpcUrl: string;
};

const DEFAULT_SETTINGS: Settings = {
  // Relative path proxied by the reverse proxy in front of this UI (Caddy in a
  // deployed setup, Vite's server.proxy in dev) to the Guardian. Keeping it
  // relative makes UI and Guardian same-origin, so there is no CORS to manage.
  // Editable in the UI to point at any absolute Guardian URL whose CORS allows
  // this origin.
  guardianEndpoint: '/guardian-proxy',
  midenRpcUrl: 'https://rpc.testnet.miden.io',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
