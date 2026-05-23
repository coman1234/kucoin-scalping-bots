export interface AppSettings {
  language:           "fi" | "en";
  // API
  apiKey:             string;
  apiSecret:          string;
  apiPassphrase:      string;
  sandboxMode:        boolean;
  // Trading
  tradeAmountUSDT:    number;
  minSignalScore:     number;
  slMultiplier:       number;
  tpMultiplier:       number;
  maxPositions:       number;
  defaultTimeframe:   string;
  // Bot features
  kellyEnabled:       boolean;
  autoOptimizerEnabled: boolean;
  feedbackLoopEnabled:  boolean;
  // Notifications
  soundAlerts:        boolean;
  browserNotifications: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  language:             "fi",
  apiKey:               "",
  apiSecret:            "",
  apiPassphrase:        "",
  sandboxMode:          false,
  tradeAmountUSDT:      100,
  minSignalScore:       4,
  slMultiplier:         1.5,
  tpMultiplier:         2.5,
  maxPositions:         3,
  defaultTimeframe:     "5min",
  kellyEnabled:         true,
  autoOptimizerEnabled: true,
  feedbackLoopEnabled:  false,
  soundAlerts:          false,
  browserNotifications: false,
};

const STORAGE_KEY = "scalping_app_settings";

export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
