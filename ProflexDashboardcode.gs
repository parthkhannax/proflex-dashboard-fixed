// ============================================================
// DAILY STOCK MOVERS & DRAGGERS — EMAIL + TELEGRAM
// ============================================================
//
// SETUP:
// 1. Open your Google Sheet > Extensions > Apps Script
// 2. Paste this entire script
// 3. Run setupDailyTrigger() once → Authorize when prompted
// 4. Done — email + Telegram daily at 8:10 PM IST
//
// SHEET: "Priority List"
//   Column A: Company Name
//   Column B: Ticker
//   Column F: Change (e.g. "+2.71%", "-3.47%")
//
// ============================================================

const CONFIG = {
  EMAIL:              "parthbusinessofficialid@gmail.com",
  SHEET_NAME:         "Priority List",
  MOVER_THRESHOLD:    2.0,
  DRAGGER_THRESHOLD:  -2.0,
  TRIGGER_HOUR:       20,
  TRIGGER_MINUTE:     10,
  TIMEZONE:           "Asia/Kolkata",
  TELEGRAM_TOKEN:     "8759213891:AAFxUWlwzzBuZKdsSTE0wDbuq_jYD11poUM",
  TELEGRAM_CHAT_ID:   "1364307717"
};

// ── YOUR PERSONAL PRIORITY WATCHLIST ──
const PRIORITY_TICKERS = new Set([
  "META", "GOOG", "NVDA", "TSLA", "AMD",
  "AVGO", "MSFT", "AMZN", "ORCL", "CDNS", "IOT"
]);


// ============================================================
// TELEGRAM HELPER
// ============================================================

function sendTelegram(message) {
  try {
    var url = "https://api.telegram.org/bot" + CONFIG.TELEGRAM_TOKEN + "/sendMessage";
    var payload = {
      chat_id:    CONFIG.TELEGRAM_CHAT_ID,
      text:       message,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    var options = {
      method:      "POST",
      contentType: "application/json",
      payload:     JSON.stringify(payload),
      muteHttpExceptions: true
    };
    var response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      Logger.log("Telegram error: " + response.getContentText());
    }
  } catch (e) {
    Logger.log("Telegram exception: " + e.toString());
  }
}


// ============================================================
// DAILY REPORT — MAIN
// ============================================================

function sendDailyStockReport() {

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) { Logger.log("ERROR: Sheet not found."); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("No data rows found."); return; }

  var companyCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var tickerCol  = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var changeCol  = sheet.getRange(2, 6, lastRow - 1, 1).getValues();

  var movers   = [];
  var draggers = [];

  for (var i = 0; i < tickerCol.length; i++) {
    var ticker    = String(tickerCol[i][0]).trim();
    var company   = String(companyCol[i][0]).trim();
    var rawChange = String(changeCol[i][0]).trim();

    if (!ticker || !rawChange) continue;

    var changeValue = parseFloat(rawChange.replace(/[%,]/g, ""));
    if (isNaN(changeValue)) continue;

    var entry = { company: company, ticker: ticker, change: changeValue };

    if      (changeValue >= CONFIG.MOVER_THRESHOLD)   movers.push(entry);
    else if (changeValue <= CONFIG.DRAGGER_THRESHOLD) draggers.push(entry);
  }

  movers.sort(function(a, b)   { return b.change - a.change; });
  draggers.sort(function(a, b) { return a.change - b.change; });

  var today   = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "EEEE, MMMM dd, yyyy");
  var timeNow = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "hh:mm a");
  var subject = "Stock Alert | " + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "dd MMM yyyy");

  // ── Send Email ──
  MailApp.sendEmail({
    to:       CONFIG.EMAIL,
    subject:  subject,
    htmlBody: buildEmailHTML(movers, draggers, today, timeNow)
  });

  // ── Send Telegram ──
  var tgMessage = buildDailyTelegramMessage(movers, draggers, today, timeNow);
  sendTelegram(tgMessage);

  Logger.log("Report sent — " + movers.length + " movers, " + draggers.length + " draggers.");
}


// ============================================================
// DAILY REPORT — TELEGRAM MESSAGE BUILDER
// ============================================================

function buildDailyTelegramMessage(movers, draggers, dateStr, timeStr) {

  var msg = "";

  // ── Header ──
  msg += "📊 <b>Daily Stock Report</b>\n";
  msg += "📅 " + dateStr + "  |  🕐 " + timeStr + " IST\n";
  msg += "━━━━━━━━━━━━━━━━━━━━━━\n\n";

  // ── Movers ──
  msg += "🟢 <b>TOP MOVERS</b>  <i>(≥ +2%)</i>\n";
  msg += "──────────────────────\n";

  if (movers.length === 0) {
    msg += "<i>No stocks crossed +2% today.</i>\n";
  } else {
    for (var i = 0; i < movers.length; i++) {
      var m        = movers[i];
      var isPrio   = PRIORITY_TICKERS.has(m.ticker.toUpperCase());
      var star     = isPrio ? " ⭐" : "";
      var change   = "+" + m.change.toFixed(2) + "%";
      msg += (i + 1) + ".  <b>" + m.ticker + "</b>" + star + "  ▲ <b>" + change + "</b>\n";
      msg += "    <i>" + m.company + "</i>\n";
    }
  }

  msg += "\n";

  // ── Draggers ──
  msg += "🔴 <b>TOP DRAGGERS</b>  <i>(≤ -2%)</i>\n";
  msg += "──────────────────────\n";

  if (draggers.length === 0) {
    msg += "<i>No stocks crossed -2% today.</i>\n";
  } else {
    for (var j = 0; j < draggers.length; j++) {
      var d      = draggers[j];
      var isPrioD = PRIORITY_TICKERS.has(d.ticker.toUpperCase());
      var starD  = isPrioD ? " ⭐" : "";
      var chgD   = d.change.toFixed(2) + "%";
      msg += (j + 1) + ".  <b>" + d.ticker + "</b>" + starD + "  ▼ <b>" + chgD + "</b>\n";
      msg += "    <i>" + d.company + "</i>\n";
    }
  }

  // ── Footer ──
  msg += "\n━━━━━━━━━━━━━━━━━━━━━━\n";
  msg += "⭐ = Watchlist  |  Threshold: ±2%\n";
  msg += "<i>Auto-generated via Apps Script</i>";

  return msg;
}


// ============================================================
// PRIORITY STOCKS — INTRADAY TRACKER (EMAIL + TELEGRAM)
// 3x Daily: Market Open · Midday · Pre-Close
// Data: Yahoo Finance · News: Finnhub · AI: Gemini
// ============================================================

const TRACKER_CONFIG = {
  EMAIL:           "parthbusinessofficialid@gmail.com",
  GEMINI_API_KEY:  "AIzaSyDXd0JWfk7vsMxz3i11w5TFnB2qclsvjJ4",
  FINNHUB_API_KEY: "d6690dhr01qots73nd9gd6690dhr01qots73nda0",
  TIMEZONE:        "Asia/Kolkata",
  TELEGRAM_TOKEN:  "8759213891:AAFxUWlwzzBuZKdsSTE0wDbuq_jYD11poUM",
  TELEGRAM_CHAT_ID:"1364307717",

  SESSIONS: {
    OPEN:     { hour: 19, minute: 15, label: "Market Open",  emoji: "🔔" },
    MIDDAY:   { hour: 21, minute: 45, label: "Midday Check", emoji: "☀️"  },
    PRECLOSE: { hour: 23, minute: 45, label: "Pre-Close",    emoji: "🔔" }
  },

  PRIORITY_TICKERS: ["META", "GOOG", "NVDA", "TSLA", "AMD", "AVGO", "MSFT", "AMZN"]
};


// ============================================================
// INTRADAY — MAIN ENTRY POINTS
// ============================================================

function sendOpenReport()     { sendIntradayReport(TRACKER_CONFIG.SESSIONS.OPEN);     }
function sendMiddayReport()   { sendIntradayReport(TRACKER_CONFIG.SESSIONS.MIDDAY);   }
function sendPreCloseReport() { sendIntradayReport(TRACKER_CONFIG.SESSIONS.PRECLOSE); }


function sendIntradayReport(session) {
  Logger.log("Starting " + session.label + " report...");

  var stockDataArr = [];

  for (var i = 0; i < TRACKER_CONFIG.PRIORITY_TICKERS.length; i++) {
    var ticker = TRACKER_CONFIG.PRIORITY_TICKERS[i];
    Logger.log("Fetching: " + ticker);

    var price = fetchYahooQuote(ticker);
    var news  = fetchFinnhubNews(ticker);

    if (price) {
      stockDataArr.push({ ticker: ticker, price: price, news: news });
    } else {
      Logger.log("Skipping " + ticker + " — no price data");
    }

    Utilities.sleep(300);
  }

  if (stockDataArr.length === 0) { Logger.log("No data fetched — aborting."); return; }

  // ── Gemini AI summaries ──
  for (var j = 0; j < stockDataArr.length; j++) {
    stockDataArr[j].aiSummary = getGeminiSummary(stockDataArr[j], session.label);
    Utilities.sleep(500);
  }

  // ── Send Email ──
  var dateStr = Utilities.formatDate(new Date(), TRACKER_CONFIG.TIMEZONE, "EEEE, MMMM dd, yyyy");
  var timeStr = Utilities.formatDate(new Date(), TRACKER_CONFIG.TIMEZONE, "hh:mm a");
  var subject = session.emoji + " " + session.label + " | Priority Stocks | " +
                Utilities.formatDate(new Date(), TRACKER_CONFIG.TIMEZONE, "dd MMM yyyy");

  MailApp.sendEmail({
    to:       TRACKER_CONFIG.EMAIL,
    subject:  subject,
    htmlBody: buildTrackerEmail(stockDataArr, session, dateStr, timeStr)
  });

  // ── Send Telegram — one message per stock ──
  var headerMsg = buildIntradayHeaderTelegram(session, dateStr, timeStr, stockDataArr);
  sendTelegramIntraday(headerMsg);
  Utilities.sleep(500);

  for (var k = 0; k < stockDataArr.length; k++) {
    var cardMsg = buildStockCardTelegram(stockDataArr[k], session, k + 1, stockDataArr.length);
    sendTelegramIntraday(cardMsg);
    Utilities.sleep(400); // avoid Telegram rate limit
  }

  Logger.log("Sent " + session.label + " — " + stockDataArr.length + " stocks.");
}


// ── Separate sendTelegram for intraday (uses TRACKER_CONFIG) ──
function sendTelegramIntraday(message) {
  try {
    var url = "https://api.telegram.org/bot" + TRACKER_CONFIG.TELEGRAM_TOKEN + "/sendMessage";
    var payload = {
      chat_id:    TRACKER_CONFIG.TELEGRAM_CHAT_ID,
      text:       message,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    var options = {
      method:      "POST",
      contentType: "application/json",
      payload:     JSON.stringify(payload),
      muteHttpExceptions: true
    };
    var response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      Logger.log("Telegram error: " + response.getContentText());
    }
  } catch (e) {
    Logger.log("Telegram exception: " + e.toString());
  }
}


// ============================================================
// INTRADAY — TELEGRAM MESSAGE BUILDERS
// ============================================================

function buildIntradayHeaderTelegram(session, dateStr, timeStr, stockDataArr) {

  var msg = "";
  msg += session.emoji + " <b>" + session.label.toUpperCase() + "</b> — Priority Watchlist\n";
  msg += "📅 " + dateStr + "  |  🕐 " + timeStr + " IST\n";
  msg += "━━━━━━━━━━━━━━━━━━━━━━\n";

  // Snapshot bar — all tickers with change
  for (var i = 0; i < stockDataArr.length; i++) {
    var sd   = stockDataArr[i];
    var p    = sd.price;
    var isUp = p.changePct >= 0;
    var arrow = isUp ? "▲" : "▼";
    var sign  = isUp ? "+" : "";
    msg += (isUp ? "🟢" : "🔴") + " <b>" + sd.ticker + "</b>  " + arrow + " " + sign + p.changePct.toFixed(2) + "%   $" + p.price.toFixed(2) + "\n";
  }

  msg += "━━━━━━━━━━━━━━━━━━━━━━\n";
  msg += "<i>Individual breakdowns follow ↓</i>";

  return msg;
}


function buildStockCardTelegram(stockData, session, index, total) {

  var p     = stockData.price;
  var isUp  = p.changePct >= 0;
  var arrow = isUp ? "▲" : "▼";
  var sign  = isUp ? "+" : "";
  var dot   = isUp ? "🟢" : "🔴";

  function fmtVol(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return v.toString();
  }

  var volLabel = p.volRatio >= 1.5 ? "🔥 HIGH" : (p.volRatio >= 1.0 ? "📊 AVG" : "📉 LOW");

  // 52-week position as simple text bar
  var wkRange = p.week52High - p.week52Low;
  var wkPct   = wkRange > 0 ? ((p.price - p.week52Low) / wkRange * 100).toFixed(0) : "50";

  var msg = "";

  // ── Card Header ──
  msg += "──────────────────────\n";
  msg += dot + "  <b>" + stockData.ticker + "</b>   <b>$" + p.price.toFixed(2) + "</b>";
  msg += "   " + arrow + " <b>" + sign + p.changePct.toFixed(2) + "%</b>  (" + sign + "$" + Math.abs(p.change).toFixed(2) + ")\n";
  if (p.marketState !== "REGULAR") {
    msg += "   <i>Market: " + p.marketState + "</i>\n";
  }
  msg += "\n";

  // ── Stats ──
  msg += "📈 <b>Day Range</b>   $" + p.dayLow.toFixed(2) + " — $" + p.dayHigh.toFixed(2) + "\n";
  msg += "📅 <b>52-Week</b>    $" + p.week52Low.toFixed(2) + " — $" + p.week52High.toFixed(2) + "  <i>(" + wkPct + "% of range)</i>\n";
  msg += "📦 <b>Volume</b>     " + fmtVol(p.volume) + "  |  " + p.volRatio.toFixed(2) + "x avg  " + volLabel + "\n";
  msg += "\n";

  // ── Latest News ──
  if (stockData.news && stockData.news.length > 0) {
    msg += "📰 <b>Latest News</b>\n";
    for (var n = 0; n < Math.min(stockData.news.length, 3); n++) {
      var headline = stockData.news[n].headline;
      if (headline.length > 80) headline = headline.substring(0, 80) + "…";
      msg += "• " + headline;
      if (stockData.news[n].source) msg += "  <i>— " + stockData.news[n].source + "</i>";
      msg += "\n";
    }
    msg += "\n";
  }

  // ── Gemini Summary ──
  msg += "✦ <b>Gemini Analysis</b>\n";
  msg += "<i>" + stockData.aiSummary.replace(/\n/g, "\n") + "</i>\n";

  return msg;
}


// ============================================================
// DATA FETCHING — YAHOO FINANCE
// ============================================================

function fetchYahooQuote(ticker) {
  try {
    var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + ticker + "?interval=1d&range=1d";
    var options = {
      method:  "GET",
      headers: { "User-Agent": "Mozilla/5.0" },
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) { Logger.log("Yahoo error: " + response.getResponseCode()); return null; }

    var json = JSON.parse(response.getContentText());
    var meta = json.chart.result[0].meta;

    var currentPrice = meta.regularMarketPrice        || 0;
    var prevClose    = meta.chartPreviousClose         || meta.previousClose || currentPrice;
    var dayHigh      = meta.regularMarketDayHigh       || currentPrice;
    var dayLow       = meta.regularMarketDayLow        || currentPrice;
    var volume       = meta.regularMarketVolume        || 0;
    var avgVolume    = meta.averageDailyVolume3Month   || 1;
    var week52High   = meta.fiftyTwoWeekHigh           || currentPrice;
    var week52Low    = meta.fiftyTwoWeekLow            || currentPrice;
    var marketState  = meta.marketState                || "REGULAR";

    var change    = currentPrice - prevClose;
    var changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    var volRatio  = avgVolume  !== 0 ? volume / avgVolume : 1;

    var rangeWidth = dayHigh - dayLow;
    var rangePos   = rangeWidth > 0 ? ((currentPrice - dayLow) / rangeWidth) * 100 : 50;
    rangePos = Math.min(100, Math.max(0, rangePos));

    return {
      ticker: ticker, price: currentPrice, prevClose: prevClose,
      change: change, changePct: changePct,
      dayHigh: dayHigh, dayLow: dayLow, rangePos: rangePos,
      volume: volume, avgVolume: avgVolume, volRatio: volRatio,
      week52High: week52High, week52Low: week52Low, marketState: marketState
    };

  } catch (e) {
    Logger.log("Yahoo exception for " + ticker + ": " + e.toString());
    return null;
  }
}


// ============================================================
// DATA FETCHING — FINNHUB NEWS
// ============================================================

function fetchFinnhubNews(ticker) {
  try {
    var today   = Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd");
    var weekAgo = Utilities.formatDate(new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000), "UTC", "yyyy-MM-dd");
    var url = "https://finnhub.io/api/v1/company-news?symbol=" + ticker +
              "&from=" + weekAgo + "&to=" + today + "&token=" + TRACKER_CONFIG.FINNHUB_API_KEY;

    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return [];

    var articles = JSON.parse(response.getContentText());
    if (!Array.isArray(articles)) return [];

    return articles.slice(0, 3).map(function(a) {
      return { headline: a.headline || "", summary: a.summary || "", url: a.url || "#", source: a.source || "", datetime: a.datetime || 0 };
    });

  } catch (e) {
    Logger.log("Finnhub error for " + ticker + ": " + e.toString());
    return [];
  }
}


// ============================================================
// GEMINI AI SUMMARY
// ============================================================

function getGeminiSummary(stockData, sessionLabel) {
  try {
    var p = stockData.price;
    var newsText = stockData.news && stockData.news.length > 0
      ? stockData.news.map(function(n, i) { return (i+1) + ". " + n.headline + (n.summary ? " — " + n.summary.substring(0, 120) : ""); }).join("\n")
      : "No recent news available.";

    var prompt =
      "You are a sharp equity analyst. Analyze " + stockData.ticker + " for the " + sessionLabel + " session.\n\n" +
      "PRICE DATA:\n" +
      "• Current: $" + p.price.toFixed(2) + "\n" +
      "• Change: " + (p.changePct >= 0 ? "+" : "") + p.changePct.toFixed(2) + "%\n" +
      "• Day Range: $" + p.dayLow.toFixed(2) + " – $" + p.dayHigh.toFixed(2) + "\n" +
      "• Volume vs Avg: " + p.volRatio.toFixed(2) + "x\n" +
      "• 52-Week Range: $" + p.week52Low.toFixed(2) + " – $" + p.week52High.toFixed(2) + "\n\n" +
      "RECENT NEWS:\n" + newsText + "\n\n" +
      "Provide a TIGHT 3-part brief (3–4 sentences total):\n" +
      "1. PRICE ACTION: What the technicals say right now.\n" +
      "2. NEWS CATALYST: Most important news item and likely impact.\n" +
      "3. WHAT MATTERS TODAY: One key level, event, or risk to watch.\n\n" +
      "Be direct, specific, no filler. Use numbers. No markdown. Plain text only.";

    var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 220 }
    };
    var options = {
      method: "POST", contentType: "application/json",
      headers: { "x-goog-api-key": TRACKER_CONFIG.GEMINI_API_KEY },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      Logger.log("Gemini error for " + stockData.ticker + ": " + response.getContentText());
      return "AI summary unavailable.";
    }

    var result = JSON.parse(response.getContentText());
    return result.candidates[0].content.parts[0].text.trim();

  } catch (e) {
    Logger.log("Gemini exception for " + stockData.ticker + ": " + e.toString());
    return "AI summary unavailable.";
  }
}


// ============================================================
// EMAIL HTML BUILDERS (unchanged from original)
// ============================================================

function buildEmailHTML(movers, draggers, dateStr, timeStr) {
  var h = "";
  h += '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Daily Stock Report</title></head>';
  h += '<body style="margin:0;padding:0;background-color:#f0f2f5;">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f2f5;">';
  h += '<tr><td align="center" style="padding:40px 16px;">';
  h += '<table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">';
  h += '<tr><td style="background-color:#111827;padding:32px 36px 26px 36px;">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td valign="bottom"><p style="margin:0 0 2px 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:#6b7280;">Daily Report</p>';
  h += '<h1 style="margin:0;font-family:Georgia,serif;font-size:24px;font-weight:700;color:#ffffff;">Stock Movers &amp; Draggers</h1></td>';
  h += '<td align="right" valign="bottom"><p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#9ca3af;">' + dateStr + '</p>';
  h += '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#6b7280;">' + timeStr + ' IST</p></td>';
  h += '</tr></table></td></tr>';
  h += '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td width="50%" align="center" style="padding:22px 0;background-color:#f9fafb;border-bottom:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">';
  h += '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:32px;font-weight:800;color:#16a34a;">' + movers.length + '</p>';
  h += '<p style="margin:5px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;">Movers</p></td>';
  h += '<td width="50%" align="center" style="padding:22px 0;background-color:#f9fafb;border-bottom:1px solid #e5e7eb;">';
  h += '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:32px;font-weight:800;color:#dc2626;">' + draggers.length + '</p>';
  h += '<p style="margin:5px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;">Draggers</p></td>';
  h += '</tr></table></td></tr>';
  h += sectionHeader("TOP MOVERS", "+2% and above", "#16a34a", "&#9650;");
  h += '<tr><td style="padding:0 36px 28px 36px;">' + (movers.length === 0 ? emptyState("No stocks crossed the +2% threshold today.") : buildTable(movers, "green")) + '</td></tr>';
  h += '<tr><td style="padding:0 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #f1f5f9;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>';
  h += sectionHeader("TOP DRAGGERS", "-2% and below", "#dc2626", "&#9660;");
  h += '<tr><td style="padding:0 36px 32px 36px;">' + (draggers.length === 0 ? emptyState("No stocks crossed the -2% threshold today.") : buildTable(draggers, "red")) + '</td></tr>';
  h += '<tr><td style="background-color:#f9fafb;padding:18px 36px;border-top:1px solid #e5e7eb;">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td><p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#9ca3af;">Thresholds: <span style="color:#16a34a;font-weight:600;">&ge; +2%</span> &nbsp;&bull;&nbsp; <span style="color:#dc2626;font-weight:600;">&le; -2%</span> &nbsp;&bull;&nbsp; <span style="color:#d97706;font-weight:600;">&#9733; Watchlist</span></p></td>';
  h += '<td align="right"><p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#d1d5db;">Auto-generated via Apps Script</p></td>';
  h += '</tr></table></td></tr>';
  h += '</table></td></tr></table></body></html>';
  return h;
}

function sectionHeader(title, subtitle, color, arrow) {
  var h = '<tr><td style="padding:28px 36px 14px 36px;">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-bottom:3px solid ' + color + ';padding-bottom:10px;">';
  h += '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#1f2937;">';
  h += '<span style="color:' + color + ';font-size:12px;">' + arrow + '</span>&nbsp;&nbsp;' + title;
  h += '<span style="font-weight:400;color:#9ca3af;font-size:12px;margin-left:8px;"> &mdash; ' + subtitle + '</span></p>';
  h += '</td></tr></table></td></tr>';
  return h;
}

function emptyState(msg) {
  return '<p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#9ca3af;font-style:italic;padding:24px 0;text-align:center;margin:0;">' + msg + '</p>';
}

function buildTable(entries, color) {
  var isGreen  = (color === "green");
  var pillBg   = isGreen ? "#dcfce7" : "#fee2e2";
  var pillText = isGreen ? "#15803d" : "#b91c1c";
  var t = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Helvetica,Arial,sans-serif;">';
  t += '<tr>';
  t += '<td style="padding:10px 8px 10px 0;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1.2px;border-bottom:2px solid #e5e7eb;" width="6%">#</td>';
  t += '<td style="padding:10px 8px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1.2px;border-bottom:2px solid #e5e7eb;" width="22%">Ticker</td>';
  t += '<td style="padding:10px 8px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1.2px;border-bottom:2px solid #e5e7eb;" width="44%">Company</td>';
  t += '<td style="padding:10px 0 10px 8px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1.2px;border-bottom:2px solid #e5e7eb;text-align:right;" width="28%">Change</td>';
  t += '</tr>';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var isPriority = PRIORITY_TICKERS.has(e.ticker.toUpperCase());
    var rowBg = isPriority ? "#fffbeb" : (i % 2 === 0 ? "#ffffff" : "#fafbfc");
    var leftBorder = isPriority ? "border-left:3px solid #f59e0b;" : "border-left:3px solid transparent;";
    var arrow = e.change >= 0 ? "&#9650;" : "&#9660;";
    var displayChange = e.change >= 0 ? "+" + e.change.toFixed(2) + "%" : e.change.toFixed(2) + "%";
    var borderBot = (i === entries.length - 1) ? "none" : "1px solid #f3f4f6";
    t += '<tr style="background-color:' + rowBg + ';' + leftBorder + '">';
    t += '<td style="padding:14px 8px 14px 4px;font-size:12px;color:#d1d5db;font-weight:600;border-bottom:' + borderBot + ';">' + (i + 1) + '</td>';
    t += '<td style="padding:14px 8px;border-bottom:' + borderBot + ';">';
    if (isPriority) {
      t += '<span style="display:inline-block;background-color:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:700;color:#92400e;">&#9733;&nbsp;' + e.ticker + '</span>';
      t += '<br><span style="font-size:9px;font-weight:600;color:#d97706;letter-spacing:0.8px;text-transform:uppercase;">Watchlist</span>';
    } else {
      t += '<span style="display:inline-block;background-color:#f1f5f9;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:700;color:#1e293b;">' + e.ticker + '</span>';
    }
    t += '</td>';
    var companyStyle = isPriority ? 'padding:14px 8px;font-size:13px;color:#78350f;font-weight:500;border-bottom:' + borderBot + ';' : 'padding:14px 8px;font-size:13px;color:#6b7280;border-bottom:' + borderBot + ';';
    t += '<td style="' + companyStyle + '">' + e.company + '</td>';
    t += '<td style="padding:14px 0 14px 8px;text-align:right;border-bottom:' + borderBot + ';">';
    t += '<span style="display:inline-block;background-color:' + pillBg + ';border-radius:20px;padding:5px 14px;font-size:12px;font-weight:700;color:' + pillText + ';white-space:nowrap;">';
    t += '<span style="font-size:9px;">' + arrow + '</span>&nbsp;' + displayChange + '</span></td>';
    t += '</tr>';
  }
  t += '</table>';
  return t;
}

function buildTrackerEmail(stockDataArr, session, dateStr, timeStr) {
  var h = "";
  h += '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Priority Tracker</title></head>';
  h += '<body style="margin:0;padding:0;background-color:#0d1117;">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d1117;">';
  h += '<tr><td align="center" style="padding:32px 16px;">';
  h += '<table role="presentation" width="660" cellpadding="0" cellspacing="0" border="0">';
  h += '<tr><td style="background:linear-gradient(135deg,#1a1f2e 0%,#0d1117 100%);border-radius:12px 12px 0 0;padding:28px 36px 24px 36px;border:1px solid #21262d;border-bottom:none;">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td valign="middle"><p style="margin:0 0 4px 0;font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#58a6ff;">Priority Watchlist</p>';
  h += '<h1 style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#f0f6fc;">' + session.emoji + ' ' + session.label + '</h1></td>';
  h += '<td align="right" valign="middle"><p style="margin:0 0 2px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#8b949e;">' + dateStr + '</p>';
  h += '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#58a6ff;font-weight:600;">' + timeStr + ' IST</p></td>';
  h += '</tr></table></td></tr>';
  h += '<tr><td style="background-color:#161b22;padding:14px 36px;border-left:1px solid #21262d;border-right:1px solid #21262d;">';
  h += '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>';
  for (var t = 0; t < stockDataArr.length; t++) {
    var sd = stockDataArr[t]; var isUp = sd.price.changePct >= 0;
    var pillColor = isUp ? "#1a4a2e" : "#4a1a1a"; var textColor = isUp ? "#3fb950" : "#f85149";
    h += '<td style="padding-right:8px;"><span style="display:inline-block;background-color:' + pillColor + ';border-radius:6px;padding:5px 10px;font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:' + textColor + ';">';
    h += sd.ticker + ' ' + (isUp ? '▲' : '▼') + ' ' + (isUp ? '+' : '') + sd.price.changePct.toFixed(2) + '%</span></td>';
  }
  h += '</tr></table></td></tr>';
  for (var i = 0; i < stockDataArr.length; i++) { h += buildStockCard(stockDataArr[i], i, stockDataArr.length); }
  h += '<tr><td style="background-color:#161b22;border-radius:0 0 12px 12px;padding:16px 36px;border:1px solid #21262d;border-top:1px solid #21262d;">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td><p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#484f58;">Data: Yahoo Finance · News: Finnhub · Analysis: Gemini AI</p></td>';
  h += '<td align="right"><p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#484f58;">Auto-generated · Not financial advice</p></td>';
  h += '</tr></table></td></tr>';
  h += '</table></td></tr></table></body></html>';
  return h;
}

function buildStockCard(stockData, index, total) {
  var p = stockData.price; var isUp = p.changePct >= 0; var isLast = (index === total - 1);
  var accentColor = isUp ? "#3fb950" : "#f85149"; var changeBg = isUp ? "#1a4a2e" : "#4a1a1a";
  var borderBottom = isLast ? "border-radius:0;" : "";
  var changeSign = isUp ? "+" : "";
  var volColor = p.volRatio >= 1.5 ? "#d29922" : (p.volRatio >= 1.0 ? "#8b949e" : "#484f58");
  var volLabel = p.volRatio >= 1.5 ? "HIGH VOL" : (p.volRatio >= 1.0 ? "AVG VOL" : "LOW VOL");
  var wkRange = p.week52High - p.week52Low; var wkPos = wkRange > 0 ? ((p.price - p.week52Low) / wkRange * 100) : 50;
  wkPos = Math.min(100, Math.max(0, wkPos));
  function fmtVol(v) { if (v >= 1e6) return (v/1e6).toFixed(1)+"M"; if (v >= 1e3) return (v/1e3).toFixed(0)+"K"; return v.toString(); }
  var h = '<tr><td style="background-color:#0d1117;border-left:1px solid #21262d;border-right:1px solid #21262d;border-bottom:1px solid #21262d;' + borderBottom + '">';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';
  h += '<tr><td style="padding:20px 36px 0 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td valign="middle"><span style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;color:#f0f6fc;">' + stockData.ticker + '</span>';
  if (p.marketState !== "REGULAR") h += '&nbsp;<span style="font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:600;color:#8b949e;background:#161b22;border-radius:4px;padding:2px 6px;">' + p.marketState + '</span>';
  h += '</td><td align="right" valign="middle"><span style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#f0f6fc;">$' + p.price.toFixed(2) + '</span>&nbsp;&nbsp;';
  h += '<span style="display:inline-block;background-color:' + changeBg + ';border-radius:8px;padding:5px 12px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:' + accentColor + ';">' + changeSign + p.changePct.toFixed(2) + '%&nbsp;(' + changeSign + '$' + Math.abs(p.change).toFixed(2) + ')</span></td>';
  h += '</tr></table></td></tr>';
  h += '<tr><td style="padding:14px 36px 0 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td width="33%" valign="top"><p style="margin:0 0 4px 0;font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#484f58;">Volume</p>';
  h += '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#f0f6fc;">' + fmtVol(p.volume) + '</p>';
  h += '<p style="margin:2px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;color:' + volColor + ';">' + p.volRatio.toFixed(2) + 'x avg &nbsp;·&nbsp; ' + volLabel + '</p></td>';
  h += '<td width="34%" valign="top"><p style="margin:0 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#484f58;">Day Range</p>';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  h += '<td style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#8b949e;white-space:nowrap;">$' + p.dayLow.toFixed(2) + '</td>';
  h += '<td style="padding:0 6px;" width="100%"><div style="background-color:#21262d;border-radius:4px;height:6px;width:100%;"><div style="background-color:' + accentColor + ';border-radius:4px;height:6px;width:' + p.rangePos.toFixed(0) + '%;"></div></div></td>';
  h += '<td style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#8b949e;white-space:nowrap;">$' + p.dayHigh.toFixed(2) + '</td>';
  h += '</tr></table></td>';
  h += '<td width="33%" valign="top" align="right"><p style="margin:0 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#484f58;">52-Week Range</p>';
  h += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right"><tr>';
  h += '<td style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#8b949e;white-space:nowrap;">$' + p.week52Low.toFixed(2) + '</td>';
  h += '<td style="padding:0 6px;" width="80px"><div style="background-color:#21262d;border-radius:4px;height:6px;width:80px;"><div style="background-color:#d29922;border-radius:4px;height:6px;width:' + wkPos.toFixed(0) + '%;"></div></div></td>';
  h += '<td style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#8b949e;white-space:nowrap;">$' + p.week52High.toFixed(2) + '</td>';
  h += '</tr></table></td>';
  h += '</tr></table></td></tr>';
  if (stockData.news && stockData.news.length > 0) {
    h += '<tr><td style="padding:16px 36px 0 36px;"><p style="margin:0 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#484f58;">Latest News</p>';
    for (var n = 0; n < stockData.news.length; n++) {
      var news = stockData.news[n]; var isLastNews = (n === stockData.news.length - 1);
      h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="' + (isLastNews ? '' : 'border-bottom:1px solid #161b22;margin-bottom:8px;padding-bottom:8px;') + '"><tr>';
      h += '<td width="4" style="padding-right:10px;"><div style="width:3px;height:32px;background-color:#21262d;border-radius:2px;"></div></td>';
      h += '<td><a href="' + news.url + '" style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;color:#58a6ff;text-decoration:none;">' + news.headline.substring(0, 90) + (news.headline.length > 90 ? '…' : '') + '</a>';
      if (news.source) h += '<p style="margin:2px 0 0 0;font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#484f58;">' + news.source + '</p>';
      h += '</td></tr></table>';
    }
    h += '</td></tr>';
  }
  h += '<tr><td style="padding:16px 36px 20px 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';
  h += '<tr><td style="background-color:#161b22;border-left:3px solid #58a6ff;border-radius:0 8px 8px 0;padding:14px 16px;">';
  h += '<p style="margin:0 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#58a6ff;">✦ Gemini Analysis</p>';
  h += '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#c9d1d9;line-height:1.6;">' + stockData.aiSummary.replace(/\n/g, '<br>') + '</p>';
  h += '</td></tr></table></td></tr>';
  h += '</table></td></tr>';
  return h;
}


// ============================================================
// TRIGGER MANAGEMENT
// ============================================================

function setupDailyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === "sendDailyStockReport") ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger("sendDailyStockReport").timeBased().atHour(CONFIG.TRIGGER_HOUR).nearMinute(CONFIG.TRIGGER_MINUTE).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log("Trigger set — daily at 8:10 PM IST");
}

function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers(); var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "sendDailyStockReport") { ScriptApp.deleteTrigger(triggers[i]); removed++; }
  }
  Logger.log("Removed " + removed + " trigger(s).");
}

function setupIntradayTriggers() {
  removeIntradayTriggers();
  var sessions = [
    { fn: "sendOpenReport",     hour: TRACKER_CONFIG.SESSIONS.OPEN.hour,     minute: TRACKER_CONFIG.SESSIONS.OPEN.minute     },
    { fn: "sendMiddayReport",   hour: TRACKER_CONFIG.SESSIONS.MIDDAY.hour,   minute: TRACKER_CONFIG.SESSIONS.MIDDAY.minute   },
    { fn: "sendPreCloseReport", hour: TRACKER_CONFIG.SESSIONS.PRECLOSE.hour, minute: TRACKER_CONFIG.SESSIONS.PRECLOSE.minute }
  ];
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    ScriptApp.newTrigger(s.fn).timeBased().atHour(s.hour).nearMinute(s.minute).everyDays(1).inTimezone(TRACKER_CONFIG.TIMEZONE).create();
    Logger.log("Trigger set: " + s.fn + " at " + s.hour + ":" + s.minute + " IST");
  }
  Logger.log("All 3 intraday triggers created.");
}

function removeIntradayTriggers() {
  var fns = ["sendOpenReport", "sendMiddayReport", "sendPreCloseReport"];
  var triggers = ScriptApp.getProjectTriggers(); var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (fns.indexOf(triggers[i].getHandlerFunction()) !== -1) { ScriptApp.deleteTrigger(triggers[i]); removed++; }
  }
  Logger.log("Removed " + removed + " intraday trigger(s).");
}


// ============================================================
// TEST FUNCTIONS
// ============================================================

function testDailyNow()    { sendDailyStockReport(); }
function testIntradayNow() { sendIntradayReport(TRACKER_CONFIG.SESSIONS.MIDDAY); }
function testTelegram()    { sendTelegram("✅ Telegram connected successfully!"); }
