"use client";
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { AppSettings } from "./settingsStore";
import { loadAppSettings, saveAppSettings, DEFAULT_APP_SETTINGS } from "./settingsStore";

interface MonitorContextValue {
  language: "fi" | "en";
  setLanguage: (lang: "fi" | "en") => void;
  appSettings: AppSettings;
  setAppSettings: (s: AppSettings) => void;
}

const MonitorContext = createContext<MonitorContextValue>({
  language: "fi",
  setLanguage: () => {},
  appSettings: DEFAULT_APP_SETTINGS,
  setAppSettings: () => {},
});

export function MonitorProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<"fi" | "en">("fi");
  const [appSettings, setAppSettingsState] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    const saved = loadAppSettings();
    setAppSettingsState(saved);
    if (saved.language === "fi" || saved.language === "en") {
      setLanguageState(saved.language);
    }
    const savedLang = localStorage.getItem("scalping_lang");
    if (savedLang === "fi" || savedLang === "en") setLanguageState(savedLang);
  }, []);

  const setLanguage = useCallback((lang: "fi" | "en") => {
    setLanguageState(lang);
    localStorage.setItem("scalping_lang", lang);
  }, []);

  const setAppSettings = useCallback((s: AppSettings) => {
    setAppSettingsState(s);
    saveAppSettings(s);
    if (s.language) {
      setLanguageState(s.language);
      localStorage.setItem("scalping_lang", s.language);
    }
  }, []);

  return (
    <MonitorContext.Provider value={{ language, setLanguage, appSettings, setAppSettings }}>
      {children}
    </MonitorContext.Provider>
  );
}

export function useMonitorContext() {
  return useContext(MonitorContext);
}
