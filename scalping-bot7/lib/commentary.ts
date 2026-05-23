import type { SignalResult } from "./signalEngine";
import type { KuCoinCandle } from "./kucoinPublic";

export function generateCommentary(
  signal: SignalResult | null,
  candles: KuCoinCandle[],
  lang: "fi" | "en" = "fi"
): string {
  const fi = lang === "fi";

  if (!signal || candles.length === 0)
    return fi ? "Ladataan markkinadataa..." : "Loading market data...";

  const ind      = signal.indicators;
  const rsi      = ind.rsi.at(-1) ?? 50;
  const lastVol  = candles.at(-1)?.volume ?? 0;
  const volMA    = ind.volumeMA.at(-1) ?? 1;
  const volRatio = volMA > 0 ? lastVol / volMA : 1;
  const ema9     = ind.ema9.at(-1) ?? 0;
  const ema21    = ind.ema21.at(-1) ?? 0;
  const hist     = ind.macd.histogram.at(-1) ?? 0;
  const price    = candles.at(-1)?.close ?? 0;
  const vwap     = ind.vwap.at(-1) ?? price;
  const gcBull   = ind.gaussianChannel?.isBullish.at(-1) ?? false;
  const regime   = ind.regime;
  const score    = signal.score;
  const max      = signal.maxScore;
  const dir      = signal.direction;
  const atr      = ind.atr.at(-1) ?? price * 0.005;

  const rsiStr = fi
    ? (rsi < 25 ? `RSI ${rsi.toFixed(0)} — äärimmäinen ylilyönti alaspäin, pohjat voivat olla lähellä` :
       rsi < 35 ? `RSI ${rsi.toFixed(0)} — selkeästi ylimyyty` :
       rsi < 45 ? `RSI ${rsi.toFixed(0)} — ostopuolella` :
       rsi > 75 ? `RSI ${rsi.toFixed(0)} — äärimmäinen yliosto, huippu voi olla lähellä` :
       rsi > 65 ? `RSI ${rsi.toFixed(0)} — selkeästi yliostettu` :
       rsi > 55 ? `RSI ${rsi.toFixed(0)} — myyntipuolella` :
                  `RSI ${rsi.toFixed(0)} — neutraali`)
    : (rsi < 25 ? `RSI ${rsi.toFixed(0)} — extreme oversold, bottom may be near` :
       rsi < 35 ? `RSI ${rsi.toFixed(0)} — clearly oversold` :
       rsi < 45 ? `RSI ${rsi.toFixed(0)} — buy-side territory` :
       rsi > 75 ? `RSI ${rsi.toFixed(0)} — extreme overbought, top may be near` :
       rsi > 65 ? `RSI ${rsi.toFixed(0)} — clearly overbought` :
       rsi > 55 ? `RSI ${rsi.toFixed(0)} — sell-side territory` :
                  `RSI ${rsi.toFixed(0)} — neutral`);

  const volStr = fi
    ? (volRatio > 2.5 ? `volyymi räjähtänyt (${volRatio.toFixed(1)}× normaali) — vahva liike` :
       volRatio > 1.5 ? `volyymi kohonnut (${volRatio.toFixed(1)}× normaali)` :
       volRatio > 1.2 ? `volyymi hieman normaalia korkeampi` :
                        `volyymi normaali — liikkeeltä puuttuu vahvistus`)
    : (volRatio > 2.5 ? `volume exploded (${volRatio.toFixed(1)}× normal) — strong move` :
       volRatio > 1.5 ? `volume elevated (${volRatio.toFixed(1)}× normal)` :
       volRatio > 1.2 ? `volume slightly above average` :
                        `volume normal — move lacks confirmation`);

  const gcStr = fi
    ? (gcBull ? "nousevassa Gaussian-kanavassa" : "laskevassa Gaussian-kanavassa")
    : (gcBull ? "in bullish Gaussian channel" : "in bearish Gaussian channel");

  const emaStr = fi
    ? (ema9 > ema21 ? "EMA9 yli EMA21 (nouseva trendi)" : "EMA9 alle EMA21 (laskeva trendi)")
    : (ema9 > ema21 ? "EMA9 above EMA21 (uptrend)" : "EMA9 below EMA21 (downtrend)");

  const vwapStr = fi
    ? (price > vwap ? "hinnan yläpuolella (ostajat hallitsevat)" : "hinnan alapuolella (myyjät hallitsevat)")
    : (price > vwap ? "above price (buyers in control)" : "below price (sellers in control)");

  const macdStr = fi
    ? (hist > 0 ? "MACD positiivinen" : "MACD negatiivinen")
    : (hist > 0 ? "MACD positive" : "MACD negative");

  const slPct = ((atr * 1.5) / price * 100).toFixed(1);

  if (regime === "VOLATILE") {
    return fi
      ? `⚠️  KORKEA VOLATILITEETTI — Markkinat heittelevät liikaa kaupankäyntiin. ATR on poikkeuksellisen korkea suhteessa hintaan. Odota ennen positioiden avaamista. ${rsiStr}, ${volStr}.`
      : `⚠️  HIGH VOLATILITY — Market is too choppy for trading. ATR is exceptionally high relative to price. Wait before opening positions. ${rsiStr}, ${volStr}.`;
  }

  if (dir === "BUY" && score >= 8) {
    const volNote = fi
      ? (volRatio < 1.2 ? "  Huomio: volyymi on matala — varaudu väärään signaaliin." : `  ${volStr.charAt(0).toUpperCase() + volStr.slice(1)}.`)
      : (volRatio < 1.2 ? "  Note: volume is low — be prepared for a false signal." : `  ${volStr.charAt(0).toUpperCase() + volStr.slice(1)}.`);
    return fi
      ? `🚀  VAHVA OSTOSUOSITUS  ${score}/${max}  —  ${score} indikaattoria tukee nousua.  Olemme ${gcStr}, ${emaStr}, VWAP ${vwapStr}.  ${rsiStr}.  ${macdStr}.${volNote}  Sisääntulo nyt hintaan ~${price.toFixed(4)}, suositeltu stop-loss ${slPct}% alle.`
      : `🚀  STRONG BUY  ${score}/${max}  —  ${score} indicators support a rally.  We are ${gcStr}, ${emaStr}, VWAP ${vwapStr}.  ${rsiStr}.  ${macdStr}.${volNote}  Entry now at ~${price.toFixed(4)}, suggested stop-loss ${slPct}% below.`;
  }

  if (dir === "BUY" && score >= 5) {
    const rsiNote = fi
      ? (rsi < 35 ? `  RSI on selkeästi ylimyyty — palautusralli on todennäköinen, mutta trendi voi silti jatkua alas.` : "")
      : (rsi < 35 ? `  RSI is clearly oversold — a recovery rally is likely, but the trend may still continue lower.` : "");
    return fi
      ? `📈  OSTOMAHDOLLISUUS KEHITTYY  ${score}/${max}  —  ${score} indikaattoria tukee nousua.  Olemme ${gcStr}, ${emaStr}.  ${rsiStr}.  VWAP ${vwapStr}.  ${volStr}.${rsiNote}  Odota vahvistusta tai pienennä positiokokoa.`
      : `📈  BUY OPPORTUNITY DEVELOPING  ${score}/${max}  —  ${score} indicators support upside.  We are ${gcStr}, ${emaStr}.  ${rsiStr}.  VWAP ${vwapStr}.  ${volStr}.${rsiNote}  Wait for confirmation or reduce position size.`;
  }

  if (dir === "BUY" && score >= 3) {
    const rsiNote = fi
      ? (rsi < 30 ? `  RSI ${rsi.toFixed(0)} on äärimmäisen alhainen — vaikka trendi on alas, lasku alkaa olla uupunut.  Älä riskaa liikaa.` :
         rsi < 45 ? `  ${rsiStr}.  Positio pienellä koolla on perusteltavissa.` : "")
      : (rsi < 30 ? `  RSI ${rsi.toFixed(0)} is extremely low — even though the trend is down, the decline may be exhausted.  Don't risk too much.` :
         rsi < 45 ? `  ${rsiStr}.  A small position size can be justified.` : "");
    return fi
      ? `🔍  HEIKKO OSTOSIGNAALI  ${score}/${max}  —  Vain ${score} indikaattoria tukee nousua.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${volStr}.${rsiNote}  Odota lisää vahvistusta ennen sisäänmenoa.`
      : `🔍  WEAK BUY SIGNAL  ${score}/${max}  —  Only ${score} indicators support upside.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${volStr}.${rsiNote}  Wait for more confirmation before entering.`;
  }

  if (dir === "SELL" && score >= 8) {
    const volNote = fi
      ? (volRatio < 1.2 ? "  Huomio: volyymi matala — myynti saattaa olla heikkoa." : `  ${volStr.charAt(0).toUpperCase() + volStr.slice(1)} — myyntipainetta on.`)
      : (volRatio < 1.2 ? "  Note: volume is low — selling pressure may be weak." : `  ${volStr.charAt(0).toUpperCase() + volStr.slice(1)} — selling pressure present.`);
    return fi
      ? `🔴  VAHVA MYYNTISUOSITUS  ${score}/${max}  —  ${score} indikaattoria tukee laskua.  Olemme ${gcStr}, ${emaStr}.  VWAP ${vwapStr}.  ${rsiStr}.  ${macdStr}.${volNote}  Sulje pitkät positiot tai shorttaa.  Suositeltu stop ${slPct}% yli.`
      : `🔴  STRONG SELL  ${score}/${max}  —  ${score} indicators support a decline.  We are ${gcStr}, ${emaStr}.  VWAP ${vwapStr}.  ${rsiStr}.  ${macdStr}.${volNote}  Close long positions or short.  Suggested stop ${slPct}% above.`;
  }

  if (dir === "SELL" && score >= 5) {
    const rsiNote = fi
      ? (rsi > 65 ? `  RSI ${rsi.toFixed(0)} selkeästi yliostossa — myyntipaine on realistinen.` :
         rsi < 35 ? `  Huomio: ${rsiStr} — lasku voi olla liioiteltu, vältä aggressiivista shorttausta.` : "")
      : (rsi > 65 ? `  RSI ${rsi.toFixed(0)} clearly overbought — selling pressure is realistic.` :
         rsi < 35 ? `  Warning: ${rsiStr} — decline may be overdone, avoid aggressive shorting.` : "");
    return fi
      ? `📉  MYYNTIPAINE KASVAA  ${score}/${max}  —  ${score} indikaattoria tukee laskua.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${rsiStr}.  VWAP ${vwapStr}.  ${volStr}.${rsiNote}  Harkitse stop-lossin tiukentamista tai position keventämistä.`
      : `📉  SELLING PRESSURE BUILDING  ${score}/${max}  —  ${score} indicators support downside.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${rsiStr}.  VWAP ${vwapStr}.  ${volStr}.${rsiNote}  Consider tightening stop-loss or reducing position.`;
  }

  if (dir === "SELL" && score >= 3) {
    const rsiNote = fi
      ? (rsi > 70 ? `  RSI ${rsi.toFixed(0)} on äärimmäisen korkea — huippu voi olla lähellä, mutta vahvistus puuttuu.` :
         rsi > 55 ? `  ${rsiStr}.` : "")
      : (rsi > 70 ? `  RSI ${rsi.toFixed(0)} is extremely high — top may be near, but confirmation is lacking.` :
         rsi > 55 ? `  ${rsiStr}.` : "");
    return fi
      ? `⚠️  HEIKKO MYYNTISIGNAALI  ${score}/${max}  —  Vain ${score} indikaattoria osoittaa alas.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${volStr}.${rsiNote}  Älä paniikkimyy — odota vahvistusta ennen toimenpiteitä.`
      : `⚠️  WEAK SELL SIGNAL  ${score}/${max}  —  Only ${score} indicators point down.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${volStr}.${rsiNote}  Don't panic-sell — wait for confirmation before acting.`;
  }

  if (regime === "TRENDING_UP") {
    if (rsi > 65)
      return fi
        ? `📊  NOUSEVA TRENDI — varovaisuus  —  Trendi on ylöspäin, mutta ${rsiStr}.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${volStr}.  Älä osta uusia huippuja — odota pullbackia sisäänmenoon.`
        : `📊  UPTREND — caution  —  Trend is up, but ${rsiStr}.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}.  ${volStr}.  Don't buy new highs — wait for a pullback to enter.`;
    return fi
      ? `📊  NOUSEVA TRENDI — ei selkeää sisääntulopaikkaa  —  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}, VWAP ${vwapStr}.  ${rsiStr}.  ${volStr}.  Odota korjausta tai pullbackia ennen ostoa.`
      : `📊  UPTREND — no clear entry  —  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${emaStr}, VWAP ${vwapStr}.  ${rsiStr}.  ${volStr}.  Wait for a correction or pullback before buying.`;
  }

  if (regime === "TRENDING_DOWN") {
    if (rsi < 35)
      return fi
        ? `📊  LASKEVA TRENDI — mutta RSI pohjalukemissa  —  Trendi on alaspäin ja olemme ${gcStr}, ${emaStr}.  ${rsiStr} — lasku on jo pitkällä.  ${volStr}.  Vältä uusia pitkiä positioita, mutta älä myöskään riskaa shorttausta tässä.`
        : `📊  DOWNTREND — but RSI near lows  —  Trend is down and we are ${gcStr}, ${emaStr}.  ${rsiStr} — the decline is already extended.  ${volStr}.  Avoid new long positions, but don't risk shorting here either.`;
    return fi
      ? `📊  LASKEVA TRENDI — pysyttele sivussa  —  Trendi on alaspäin, ${gcStr}, ${emaStr}, VWAP ${vwapStr}.  ${rsiStr}.  ${volStr}.  Myy ralleilla, vältä uusia pitkiä positioita.`
      : `📊  DOWNTREND — stay on sidelines  —  Trend is down, ${gcStr}, ${emaStr}, VWAP ${vwapStr}.  ${rsiStr}.  ${volStr}.  Sell rallies, avoid new long positions.`;
  }

  if (rsi < 35)
    return fi
      ? `⚖️  SIVUTTAISLIIKE — ostopaikka kypsymässä  —  Markkina liikkuu sivuttain ilman selvää trendiä.  ${rsiStr} — mahdollinen palautusralli lähellä.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${macdStr}.  ${volStr}.  Varo kuitenkin — sivuttaismarkkinassa RSI voi pysyä alhaalla pitkään.`
      : `⚖️  RANGING — buy opportunity developing  —  Market is moving sideways without a clear trend.  ${rsiStr} — potential recovery rally near.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${macdStr}.  ${volStr}.  Be careful though — RSI can stay low for a long time in ranging markets.`;

  if (rsi > 65)
    return fi
      ? `⚖️  SIVUTTAISLIIKE — myyntipaine mahdollinen  —  Markkina liikkuu sivuttain.  ${rsiStr} — yliostoa sivuttaismarkkinassa.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${macdStr}.  ${volStr}.  Varo ostamasta huipuista.`
      : `⚖️  RANGING — potential selling pressure  —  Market is moving sideways.  ${rsiStr} — overbought in a ranging market.  ${gcStr.charAt(0).toUpperCase() + gcStr.slice(1)}, ${macdStr}.  ${volStr}.  Avoid buying at highs.`;

  return fi
    ? `⚖️  SIVUTTAISLIIKE — odota suuntaa  —  Ei selvää trendiä.  ${rsiStr}, ${gcStr}, ${macdStr}.  ${volStr}.  Odota selkeämpää signaalia ennen suurempia positioita.`
    : `⚖️  RANGING — wait for direction  —  No clear trend.  ${rsiStr}, ${gcStr}, ${macdStr}.  ${volStr}.  Wait for a clearer signal before taking larger positions.`;
}
