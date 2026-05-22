"use client";
import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

export interface TradingContextType {
  apiKey: string;
  setApiKey: (v: string) => void;
  apiSecret: string;
  setApiSecret: (v: string) => void;
  passphrase: string;
  setPassphrase: (v: string) => void;
  credentialsValid: boolean;
}

const TradingContext = createContext<TradingContextType>({} as TradingContextType);

export function TradingProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const credentialsValid = !!(apiKey && apiSecret && passphrase);

  useEffect(() => {
    setApiKey(localStorage.getItem("kc_api_key") ?? "");
    setApiSecret(localStorage.getItem("kc_api_secret") ?? "");
    setPassphrase(localStorage.getItem("kc_passphrase") ?? "");
  }, []);

  useEffect(() => { if (apiKey) localStorage.setItem("kc_api_key", apiKey); }, [apiKey]);
  useEffect(() => { if (apiSecret) localStorage.setItem("kc_api_secret", apiSecret); }, [apiSecret]);
  useEffect(() => { if (passphrase) localStorage.setItem("kc_passphrase", passphrase); }, [passphrase]);

  return (
    <TradingContext.Provider value={{ apiKey, setApiKey, apiSecret, setApiSecret, passphrase, setPassphrase, credentialsValid }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext() { return useContext(TradingContext); }
