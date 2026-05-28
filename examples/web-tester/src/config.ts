const STORAGE_KEY = 'multisig-tester-settings';

export type Settings = {
  guardianEndpoint: string;
  midenRpcUrl: string;
};

const DEFAULT_SETTINGS: Settings = {
  // Default to the Vite dev-server proxy path. Avoids CORS against the staging
  // Guardian (which does not send Access-Control-Allow-Origin headers).
  // For a non-localhost Guardian deployment with CORS enabled, set the
  // absolute URL here.
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
