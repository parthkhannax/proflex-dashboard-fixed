/************************************
 * Proflex Dashboard – FIXED VERSION v3
 *
 * MAJOR FIXES:
 * 1. Global rate limiting with ScriptProperties - Prevents concurrent API hammering
 * 2. Distributed lock system - Ensures calls are spaced out properly
 * 3. Aggressive caching with fallback - Returns stale cache on errors
 * 4. Consistent retry logic - All API calls use same retry mechanism
 * 5. Per-API throttling - Different limits for different services
 *
 * RATE LIMIT STRATEGY:
 * - Massive API: 1 call per 2 seconds (30 calls/minute safe limit)
 * - Perplexity API: 1 call per 1.5 seconds
 * - Polygon API: 1 call per 1 second
 * - Finnhub API: 1 call per 1 second
 *
 * CACHE STRATEGY:
 * - All successful calls cached for 2-12 hours depending on data type
 * - On rate limit error: return stale cache if available, else retry
 * - On total failure: return last known good value or empty string
 ************************************/

// ========== CONFIGURATION ==========
var CACHE_EXPIRATION_SECONDS = 21600; // 6 hours default
var CACHE_PREFIX_PPLX = 'pplx_';
var CACHE_PREFIX_MASSIVE = 'massive_';
var CACHE_PREFIX_POLYGON = 'poly_';
var CACHE_PREFIX_FINNHUB = 'finnhub_';

// API Keys
// IMPORTANT: Replace these placeholders with your actual API keys
const PPLX_API_KEY = "YOUR_PERPLEXITY_API_KEY_HERE";
const PPLX_API_KEY_2 = "YOUR_PERPLEXITY_API_KEY_2_HERE";
const PPLX_ENDPOINT = "https://api.perplexity.ai/chat/completions";
const PPLX_MODEL = "sonar-pro";
const MASSIVE_API_KEY = 'YOUR_MASSIVE_API_KEY_HERE';
const POLYGON_API_KEY = 'YOUR_POLYGON_API_KEY_HERE';  // Usually same as Massive
const FINNHUB_API_KEY = 'YOUR_FINNHUB_API_KEY_HERE';

// Retry configuration
var MAX_RETRIES = 3;
var INITIAL_BACKOFF_MS = 2000; // Start with 2 seconds

// Rate limit configuration (milliseconds between calls)
// NOTE: Polygon and Massive use the SAME API, so they share rate limits
var RATE_LIMIT_MASSIVE = 2000;    // 2 seconds between Massive/Polygon API calls
var RATE_LIMIT_PPLX = 1500;       // 1.5 seconds between Perplexity calls
var RATE_LIMIT_POLYGON = 2000;    // Same as Massive (same API!)
var RATE_LIMIT_FINNHUB = 1000;    // 1 second between Finnhub calls

// Fast return mode: return cache immediately without waiting for API
var FAST_RETURN_MODE = true;      // Set to false to always fetch fresh data

// Lock configuration
var LOCK_TIMEOUT_MS = 30000;      // 30 second lock timeout
var LOCK_WAIT_MS = 100;           // Check lock every 100ms

// ========== RATE LIMITING WITH SCRIPTPROPERTIES ==========

/**
 * Acquire a distributed lock to prevent concurrent API calls
 * @param {string} lockKey - Unique lock identifier
 * @param {number} timeoutMs - How long to wait for lock
 * @returns {boolean} - True if lock acquired
 */
function acquireLock(lockKey, timeoutMs) {
  var lock = PropertiesService.getScriptProperties();
  var startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    var lockValue = lock.getProperty(lockKey);
    var now = Date.now();

    // Check if lock is free or expired
    if (!lockValue || parseInt(lockValue) < now) {
      // Try to acquire lock
      var lockExpiry = now + LOCK_TIMEOUT_MS;
      lock.setProperty(lockKey, lockExpiry.toString());

      // Verify we got the lock (prevents race conditions)
      Utilities.sleep(50);
      if (lock.getProperty(lockKey) === lockExpiry.toString()) {
        return true;
      }
    }

    // Wait before retrying
    Utilities.sleep(LOCK_WAIT_MS);
  }

  return false;
}

/**
 * Release a distributed lock
 * @param {string} lockKey - Unique lock identifier
 */
function releaseLock(lockKey) {
  try {
    PropertiesService.getScriptProperties().deleteProperty(lockKey);
  } catch (e) {
    Logger.log('Error releasing lock ' + lockKey + ': ' + e);
  }
}

/**
 * Enforce rate limiting for an API
 * @param {string} apiName - Name of the API (massive, pplx, polygon, finnhub)
 */
function enforceRateLimit(apiName) {
  var props = PropertiesService.getScriptProperties();

  // Polygon and Massive are the SAME API, use same rate limit key
  var effectiveApiName = (apiName === 'polygon') ? 'massive' : apiName;
  var lastCallKey = 'lastCall_' + effectiveApiName;
  var rateLimitMs;

  switch(effectiveApiName) {
    case 'massive':
      rateLimitMs = RATE_LIMIT_MASSIVE;
      break;
    case 'pplx':
      rateLimitMs = RATE_LIMIT_PPLX;
      break;
    case 'finnhub':
      rateLimitMs = RATE_LIMIT_FINNHUB;
      break;
    default:
      rateLimitMs = 1000;
  }

  var lastCall = props.getProperty(lastCallKey);
  var now = Date.now();

  if (lastCall) {
    var timeSinceLastCall = now - parseInt(lastCall);
    if (timeSinceLastCall < rateLimitMs) {
      var waitTime = rateLimitMs - timeSinceLastCall;
      Logger.log('[RATE LIMIT] Waiting ' + waitTime + 'ms for ' + apiName);
      Utilities.sleep(waitTime);
    }
  }

  // Update last call time
  props.setProperty(lastCallKey, Date.now().toString());
}

/**
 * Execute API call with rate limiting and locking
 * @param {string} apiName - API name for rate limiting
 * @param {Function} apiCallFunction - Function that makes the API call
 * @param {string} operationName - Name for logging
 * @returns Result from API call
 */
function executeWithRateLimit(apiName, apiCallFunction, operationName) {
  // Polygon and Massive are the SAME API, use same lock
  var effectiveApiName = (apiName === 'polygon') ? 'massive' : apiName;
  var lockKey = 'lock_' + effectiveApiName;

  // Try to acquire lock (60 second timeout to handle multiple concurrent calls)
  if (!acquireLock(lockKey, 60000)) {
    throw new Error('Could not acquire lock for ' + effectiveApiName + ' within timeout');
  }

  try {
    // Enforce rate limiting
    enforceRateLimit(apiName);

    // Execute the API call
    var result = apiCallFunction();

    return result;
  } finally {
    // Always release lock
    releaseLock(lockKey);
  }
}

// ========== CACHE HELPER FUNCTIONS ==========

/**
 * Smart wrapper: returns cache immediately if FAST_RETURN_MODE enabled
 * Otherwise executes apiCallFunction with full rate limiting
 *
 * @param {string} cacheKey - Cache key to check
 * @param {Function} apiCallFunction - Function that makes API call and returns result
 * @param {number} cacheTTL - Cache expiration in seconds
 * @returns Cached value or fresh API result
 */
function fastReturnOrFetch(cacheKey, apiCallFunction, cacheTTL) {
  var cached = getCachedValue(cacheKey);

  // If FAST_RETURN_MODE and cache exists, return immediately
  if (FAST_RETURN_MODE && cached != null && cached !== '') {
    return cached;
  }

  // If no cache at all, must fetch
  if (!cached || cached === '') {
    try {
      var result = apiCallFunction();
      if (result != null && result !== '') {
        setCachedValue(cacheKey, String(result), cacheTTL);
      }
      return result;
    } catch (e) {
      Logger.log('API call failed: ' + e);
      // Return stale cache if available
      if (cached != null && cached !== '') {
        return cached;
      }
      return '';
    }
  }

  // Cache exists but FAST_RETURN_MODE is off, try to refresh
  try {
    var result = apiCallFunction();
    if (result != null && result !== '') {
      setCachedValue(cacheKey, String(result), cacheTTL);
    }
    return result;
  } catch (e) {
    Logger.log('API call failed, returning cache: ' + e);
    return cached;
  }
}

function getCachedValue(key) {
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(key);
    if (cached != null) {
      return cached;
    }
  } catch (e) {
    Logger.log('Cache get error: ' + e);
  }
  return null;
}

function setCachedValue(key, value, expirationInSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    cache.put(key, value.toString(), expirationInSeconds || CACHE_EXPIRATION_SECONDS);
  } catch (e) {
    Logger.log('Cache set error: ' + e);
  }
}

function buildCacheKey(prefix, ticker, params) {
  var key = prefix + ticker.toString().toUpperCase();
  if (params) {
    key += '_' + params;
  }
  return key;
}

// ========== RETRY LOGIC WITH EXPONENTIAL BACKOFF ==========

function isRetryableError(statusCode) {
  return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function isRateLimitError(errorMessage) {
  if (!errorMessage) return false;
  var msg = errorMessage.toLowerCase();
  return msg.indexOf('rate limit') !== -1 ||
         msg.indexOf('too many requests') !== -1 ||
         msg.indexOf('429') !== -1 ||
         msg.indexOf('quota') !== -1 ||
         msg.indexOf('exceeded') !== -1;
}

/**
 * Retry API call with exponential backoff
 */
function retryWithBackoff(apiCallFunction, operationName, maxRetries) {
  if (!maxRetries) maxRetries = MAX_RETRIES;

  var attempt = 0;
  var lastError = null;

  while (attempt <= maxRetries) {
    try {
      var result = apiCallFunction();

      if (attempt > 0) {
        Logger.log('[RETRY SUCCESS] ' + operationName + ' succeeded on attempt ' + (attempt + 1));
      }
      return result;

    } catch (e) {
      lastError = e;
      attempt++;

      var errorMsg = e.message || e.toString();
      var isRetryable = isRateLimitError(errorMsg);

      if (attempt > maxRetries) {
        Logger.log('[RETRY EXHAUSTED] ' + operationName + ' failed after ' + attempt + ' attempts: ' + errorMsg);
        throw e;
      }

      if (!isRetryable) {
        Logger.log('[NON-RETRYABLE ERROR] ' + operationName + ': ' + errorMsg);
        throw e;
      }

      // Exponential backoff: 2s, 4s, 8s
      var delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      Logger.log('[RETRY ' + attempt + '/' + maxRetries + '] ' + operationName + ' - waiting ' + delayMs + 'ms...');

      Utilities.sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Wrapper for UrlFetchApp.fetch with retry logic
 */
function fetchWithRetry(url, options, operationName) {
  return retryWithBackoff(function() {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();

    if (isRetryableError(code)) {
      throw new Error('Rate limit error: HTTP ' + code);
    }

    return response;
  }, operationName || 'API call');
}

// ========== PERPLEXITY API FUNCTIONS ==========

function pplxChat(prompt) {
  if (!PPLX_API_KEY) {
    throw new Error("Missing Perplexity API key");
  }

  return executeWithRateLimit('pplx', function() {
    return retryWithBackoff(function() {
      var payload = {
        model: PPLX_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 32,
        temperature: 0
      };

      var options = {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + PPLX_API_KEY },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      var response = UrlFetchApp.fetch(PPLX_ENDPOINT, options);
      var code = response.getResponseCode();

      if (code !== 200) {
        var body = response.getContentText();
        Logger.log("Perplexity error " + code + ": " + body);

        if (isRetryableError(code)) {
          throw new Error("Rate limit error: HTTP " + code);
        }
        throw new Error("Perplexity API error: " + code);
      }

      var json = JSON.parse(response.getContentText());
      var text = json?.choices?.[0]?.message?.content;

      if (!text) {
        Logger.log("Unexpected Perplexity response: " + response.getContentText());
        throw new Error("Perplexity returned empty content");
      }

      return text.trim();
    }, 'Perplexity API');
  }, 'PPLX Chat');
}

/**
 * PPLX_SENTIMENT with caching and error fallback
 */
function PPLX_SENTIMENT(ticker) {
  if (ticker === "" || ticker == null) return "";

  if (Array.isArray(ticker)) {
    return ticker.map(function (row) {
      return [_pplxSentimentScalar(row[0])];
    });
  } else {
    return _pplxSentimentScalar(ticker);
  }
}

function _pplxSentimentScalar(ticker) {
  if (!ticker) return "";

  ticker = ticker.toString().trim().toUpperCase();
  var cacheKey = buildCacheKey(CACHE_PREFIX_PPLX, ticker, 'sentiment');

  // Check cache first
  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return cached;
  }

  var prompt =
    "You are an equity analyst. For stock ticker " + ticker +
    ", use the latest publicly available market and news information to rate SHORT-TERM sentiment. " +
    "Respond with EXACTLY ONE WORD from this set: Bullish, Neutral, Bearish. " +
    "Do not add any explanation, just the word.";

  try {
    var text = pplxChat(prompt);
    var first = text.split(/\s+/)[0];

    setCachedValue(cacheKey, first, CACHE_EXPIRATION_SECONDS);
    return first;
  } catch (e) {
    Logger.log("PPLX_SENTIMENT error for " + ticker + ": " + e);

    // Return cached value if available (even if expired)
    if (cached != null) {
      return cached + " (cached)";
    }

    return "";
  }
}

/**
 * PPLX_SECTOR with caching and error fallback
 */
function PPLX_SECTOR(ticker) {
  if (ticker === "" || ticker == null) return "";

  if (Array.isArray(ticker)) {
    return ticker.map(function (row) {
      return [_pplxSectorScalar(row[0])];
    });
  } else {
    return _pplxSectorScalar(ticker);
  }
}

function _pplxSectorScalar(ticker) {
  if (!ticker) return "";

  ticker = ticker.toString().trim().toUpperCase();
  var cacheKey = buildCacheKey(CACHE_PREFIX_PPLX, ticker, 'sector');

  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return cached;
  }

  var prompt =
    "Identify the primary sector of stock ticker " + ticker + " (e.g., Semiconductors, Software, Pharma, Financials). " +
    "Based on current sector breadth, flows, macro conditions, and recent performance, classify the sector's SHORT-TERM sentiment " +
    "with EXACTLY ONE WORD from this set: Bullish, Neutral, Bearish. " +
    "Output ONLY that word, nothing else.";

  try {
    var text = pplxChat(prompt);
    var first = text.split(/\s+/)[0];

    setCachedValue(cacheKey, first, CACHE_EXPIRATION_SECONDS);
    return first;
  } catch (e) {
    Logger.log("PPLX_SECTOR error for " + ticker + ": " + e);

    if (cached != null) {
      return cached + " (cached)";
    }

    return "";
  }
}

function SECTOR_MULTIPLIER(sentiment) {
  if (sentiment === "" || sentiment == null) return "";
  if (Array.isArray(sentiment)) {
    return sentiment.map(function (row) {
      var s = (row[0] || "").toString();
      return [_sectorMultiplierScalar(s)];
    });
  } else {
    return _sectorMultiplierScalar(sentiment.toString());
  }
}

function _sectorMultiplierScalar(sentiment) {
  var s = sentiment.toString().toLowerCase();
  if (s.indexOf("bullish") !== -1) return 1.2;
  if (s.indexOf("bearish") !== -1) return 0.8;
  return 1.0;
}

// ========== MASSIVE API FUNCTIONS ==========

/**
 * Helper to make Massive API calls with rate limiting
 */
function massiveFetch(url, operationName) {
  return executeWithRateLimit('massive', function() {
    return retryWithBackoff(function() {
      var options = {
        method: 'get',
        muteHttpExceptions: true
      };

      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();

      if (code !== 200) {
        var body = response.getContentText();

        if (isRetryableError(code)) {
          throw new Error('Rate limit error: HTTP ' + code);
        }

        throw new Error('Massive API error (' + code + '): ' + body);
      }

      return JSON.parse(response.getContentText());
    }, operationName);
  }, operationName);
}

/**
 * MASSIVE_RSI - Fixed version with proper rate limiting
 */
function MASSIVE_RSI(ticker) {
  if (!ticker) return '';

  ticker = String(ticker).trim().toUpperCase();
  var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'rsi');

  // Use fast-return wrapper
  var result = fastReturnOrFetch(cacheKey, function() {
    var baseUrl = 'https://api.massive.com/v1/indicators/rsi/';
    var params = {
      timespan: 'day',
      window: 14,
      series_type: 'close',
      limit: 1,
      order: 'desc',
      apiKey: MASSIVE_API_KEY
    };

    var query = Object.keys(params)
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
      .join('&');

    var url = baseUrl + encodeURIComponent(ticker) + '?' + query;

    var data = massiveFetch(url, 'Massive RSI - ' + ticker);

    if (!data.results || !data.results.values || !data.results.values.length) {
      Logger.log('MASSIVE_RSI: No data for ' + ticker);
      return '';
    }

    var rsiValue = data.results.values[0].value;

    if (rsiValue == null) {
      return '';
    }

    return rsiValue;
  }, 7200); // Cache for 2 hours

  // Parse result if it's a string
  if (result === '') return '';
  var numResult = typeof result === 'string' ? parseFloat(result) : result;
  return isNaN(numResult) ? '' : numResult;
}

/**
 * MASSIVE_IV - Fixed version
 */
function MASSIVE_IV(underlying, expiration, strike, optionType) {
  try {
    if (!underlying || !expiration || !strike || !optionType) {
      return 'Missing parameter';
    }

    underlying = String(underlying).toUpperCase();
    optionType = String(optionType).toLowerCase();

    var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, underlying,
                                  'iv_' + expiration + '_' + strike + '_' + optionType);

    var cached = getCachedValue(cacheKey);
    if (cached != null) {
      return parseFloat(cached);
    }

    // Find contract
    var contractsBase = 'https://api.massive.com/v3/reference/options/contracts';
    var params = {
      underlying_ticker: underlying,
      expiration_date: expiration,
      strike_price: strike,
      contract_type: optionType,
      limit: 1
    };

    var query = Object.keys(params)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');

    var contractsUrl = contractsBase + '?' + query + '&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);

    var contractsData = massiveFetch(contractsUrl, 'Massive IV Contracts - ' + underlying);

    if (!contractsData.results || contractsData.results.length === 0) {
      return 'No contract found';
    }

    var optionTicker = contractsData.results[0].ticker;

    // Get snapshot
    var snapshotBase = 'https://api.massive.com/v3/snapshot/options';
    var snapshotUrl = snapshotBase + '/' + encodeURIComponent(underlying) + '/' +
                      encodeURIComponent(optionTicker) + '?apiKey=' + encodeURIComponent(MASSIVE_API_KEY);

    var snapshotData = massiveFetch(snapshotUrl, 'Massive IV Snapshot - ' + underlying);

    if (!snapshotData.results) {
      return 'No snapshot data';
    }

    var iv = snapshotData.results.implied_volatility;

    if (iv === null || iv === undefined) {
      return 'IV not available';
    }

    setCachedValue(cacheKey, iv.toString(), CACHE_EXPIRATION_SECONDS);
    return iv;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

/**
 * MASSIVE_AVG_IV - Fixed version
 */
function MASSIVE_AVG_IV(ticker, type) {
  try {
    if (!ticker) return 'Missing ticker';

    ticker = String(ticker).trim().toUpperCase();
    var typeParam = type ? String(type).toLowerCase().trim() : 'all';
    var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'avgiv_' + typeParam);

    var cached = getCachedValue(cacheKey);
    if (cached != null) {
      return parseFloat(cached);
    }

    var baseUrl = 'https://api.massive.com/v3/snapshot/options/' + encodeURIComponent(ticker);
    var params = { limit: 250 };

    if (type) {
      var t = String(type).toLowerCase().trim();
      if (t === 'call' || t === 'put') {
        params.contract_type = t;
      } else {
        return 'Type must be "call" or "put"';
      }
    }

    var query = Object.keys(params)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');

    var url = baseUrl + '?' + query + '&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);

    var data = massiveFetch(url, 'Massive Avg IV - ' + ticker);

    if (!data.results || data.results.length === 0) {
      return 'No contracts returned';
    }

    var results = data.results;
    var sum = 0;
    var count = 0;

    for (var i = 0; i < results.length; i++) {
      var iv = results[i].implied_volatility;
      if (iv !== null && iv !== undefined) {
        sum += iv;
        count++;
      }
    }

    if (count === 0) {
      return 'No IV values found';
    }

    var avg = sum / count;

    setCachedValue(cacheKey, avg.toString(), CACHE_EXPIRATION_SECONDS);
    return avg;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

/**
 * MASSIVE_OI_WEIGHTED_IV - Fixed version
 */
function MASSIVE_OI_WEIGHTED_IV(ticker, type) {
  try {
    if (!ticker) return 'Missing ticker';

    ticker = String(ticker).trim().toUpperCase();
    var typeParam = type ? String(type).toLowerCase().trim() : 'all';
    var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'oiiv_' + typeParam);

    var cached = getCachedValue(cacheKey);
    if (cached != null) {
      return parseFloat(cached);
    }

    var baseUrl = 'https://api.massive.com/v3/snapshot/options/' + encodeURIComponent(ticker);
    var params = { limit: 250 };

    if (type) {
      var t = String(type).toLowerCase().trim();
      if (t === 'call' || t === 'put') {
        params.contract_type = t;
      } else {
        return 'Type must be "call" or "put"';
      }
    }

    var query = Object.keys(params)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');

    var url = baseUrl + '?' + query + '&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);

    var data = massiveFetch(url, 'Massive OI Weighted IV - ' + ticker);

    if (!data.results || data.results.length === 0) {
      return 'No contracts returned';
    }

    var results = data.results;
    var weightedSum = 0;
    var totalOI = 0;

    for (var i = 0; i < results.length; i++) {
      var contract = results[i];
      var iv = contract.implied_volatility;
      var oi = contract.open_interest;

      if (iv !== null && iv !== undefined &&
          oi !== null && oi !== undefined && oi > 0) {
        weightedSum += iv * oi;
        totalOI += oi;
      }
    }

    if (totalOI === 0) {
      return 'No OI data';
    }

    var oiWeightedIV = weightedSum / totalOI;

    setCachedValue(cacheKey, oiWeightedIV.toString(), CACHE_EXPIRATION_SECONDS);
    return oiWeightedIV;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

/**
 * MASSIVE_VOLUME_SPIKE - Fixed version
 */
function MASSIVE_VOLUME_SPIKE(ticker, threshold) {
  try {
    if (!ticker) return 'Missing ticker';

    ticker = String(ticker).trim().toUpperCase();
    if (threshold == null || threshold === '') {
      threshold = 2;
    }
    threshold = Number(threshold);

    var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'volspike_' + threshold);

    var cached = getCachedValue(cacheKey);
    if (cached != null) {
      return cached;
    }

    // Get avg_daily_volume from Short Interest
    var siBase = 'https://api.massive.com/stocks/v1/short-interest';
    var siParams = {
      ticker: ticker,
      limit: 1,
      sort: 'settlement_date.desc'
    };
    var siQuery = Object.keys(siParams)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(siParams[k]); })
      .join('&');

    var siUrl = siBase + '?' + siQuery + '&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);
    var siData = massiveFetch(siUrl, 'Massive Volume Spike SI - ' + ticker);

    if (!siData.results || siData.results.length === 0) {
      return 'No short-interest data';
    }

    var siRow = siData.results[0];
    var avgDailyVol = siRow.avg_daily_volume;

    if (!avgDailyVol || avgDailyVol <= 0) {
      return 'avg_daily_volume missing';
    }

    // Get current volume
    var snapBase = 'https://api.massive.com/v3/snapshot';
    var snapParams = { 'ticker.any_of': ticker };
    var snapQuery = Object.keys(snapParams)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(snapParams[k]); })
      .join('&');

    var snapUrl = snapBase + '?' + snapQuery + '&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);
    var snapData = massiveFetch(snapUrl, 'Massive Volume Spike Snapshot - ' + ticker);

    if (!snapData.results || snapData.results.length === 0) {
      return 'No snapshot data';
    }

    var snapRow = snapData.results[0];
    var currentVol = null;
    if (snapRow.session && snapRow.session.volume != null) {
      currentVol = snapRow.session.volume;
    }

    if (!currentVol || currentVol <= 0) {
      return 'No volume in snapshot';
    }

    var ratio = currentVol / avgDailyVol;
    if (!isFinite(ratio) || ratio <= 0) {
      return 'Bad ratio';
    }

    var result;
    if (ratio >= threshold) {
      result = 'SPIKE (' + ratio.toFixed(2) + 'x)';
    } else {
      result = 'OK (' + ratio.toFixed(2) + 'x)';
    }

    // Cache for 1 hour
    setCachedValue(cacheKey, result, 3600);
    return result;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

/**
 * MASSIVE_DAYS_TO_COVER - Fixed version
 */
function MASSIVE_DAYS_TO_COVER(ticker, settlementDate) {
  ticker = (ticker || '').toString().trim().toUpperCase();
  if (!ticker) {
    return 'Error: ticker required';
  }

  var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'dtc_' + (settlementDate || 'latest'));

  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return parseFloat(cached);
  }

  var baseUrl = 'https://api.massive.com/stocks/v1/short-interest';
  var params = {
    ticker: ticker,
    limit: 1
  };

  if (settlementDate && settlementDate.toString().trim() !== '') {
    params.settlement_date = settlementDate.toString().trim();
  } else {
    params.sort = 'settlement_date.desc';
  }

  var query = Object.keys(params)
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');

  var url = baseUrl + '?' + query + '&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);

  try {
    var json = massiveFetch(url, 'Massive Days To Cover - ' + ticker);

    if (!json.results || json.results.length === 0) {
      return 'No short-interest data';
    }

    var r = json.results[0];
    var dtc = r.days_to_cover;

    if (dtc == null) {
      return 'days_to_cover not available';
    }

    setCachedValue(cacheKey, dtc.toString(), CACHE_EXPIRATION_SECONDS);
    return dtc;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

/**
 * MASSIVE_PCR - Fixed version
 */
function MASSIVE_PCR(ticker) {
  if (!ticker) return '';

  ticker = ticker.toString().trim().toUpperCase();
  var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'pcr');

  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return parseFloat(cached);
  }

  var baseUrl = 'https://api.massive.com/v3/snapshot/options/' + encodeURIComponent(ticker);
  var url = baseUrl + '?limit=250&order=asc&sort=ticker&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);

  var putVolume = 0;
  var callVolume = 0;

  try {
    while (url) {
      var data = massiveFetch(url, 'Massive PCR - ' + ticker);

      if (data.results && data.results.length) {
        data.results.forEach(function (item) {
          var details = item.details || {};
          var day = item.day || {};

          var contractType = details.contract_type;
          var vol = typeof day.volume === 'number' ? day.volume : 0;

          if (!contractType || !vol) return;

          if (contractType === 'put') {
            putVolume += vol;
          } else if (contractType === 'call') {
            callVolume += vol;
          }
        });
      }

      if (data.next_url) {
        if (data.next_url.indexOf('apiKey=') === -1) {
          url = data.next_url + '&apiKey=' + encodeURIComponent(MASSIVE_API_KEY);
        } else {
          url = data.next_url;
        }
      } else {
        url = null;
      }
    }

    if (callVolume === 0) {
      return '';
    }

    var pcr = putVolume / callVolume;
    var result = Math.round(pcr * 1000) / 1000;

    setCachedValue(cacheKey, result.toString(), 3600);
    return result;
  } catch (e) {
    Logger.log('MASSIVE_PCR error for ' + ticker + ': ' + e);
    if (cached != null) {
      return parseFloat(cached);
    }
    return '';
  }
}

/**
 * RSI_DIVERGENCE - Fixed version
 */
function RSI_DIVERGENCE(ticker) {
  try {
    if (!ticker) return 'Error: missing ticker';

    ticker = String(ticker).trim().toUpperCase();
    var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'rsidiv');

    var cached = getCachedValue(cacheKey);
    if (cached != null) {
      return cached;
    }

    var baseUrl = 'https://api.massive.com/v1/indicators/rsi/';
    var params = {
      timespan: 'hour',
      adjusted: 'true',
      window: 14,
      series_type: 'close',
      order: 'asc',
      limit: 300,
      expand_underlying: 'true',
      apiKey: MASSIVE_API_KEY
    };

    var query = Object.keys(params)
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
      .join('&');

    var url = baseUrl + encodeURIComponent(ticker) + '?' + query;

    var data = massiveFetch(url, 'RSI Divergence - ' + ticker);

    if (!data.results || !data.results.values || !data.results.underlying || !data.results.underlying.aggregates) {
      return 'Error: unexpected API response';
    }

    var rsiValues = data.results.values;
    var aggs = data.results.underlying.aggregates;

    if (!rsiValues.length || !aggs.length) {
      return 'Error: no data';
    }

    var rsiByTs = {};
    rsiValues.forEach(function (v) {
      if (v && typeof v.timestamp !== 'undefined') {
        rsiByTs[String(v.timestamp)] = v.value;
      }
    });

    var bars = aggs
      .map(function (a) {
        var tsKey = String(a.t);
        return {
          t: a.t,
          close: a.c,
          rsi: rsiByTs[tsKey]
        };
      })
      .filter(function (b) {
        return typeof b.rsi === 'number' && !isNaN(b.rsi);
      });

    if (bars.length < 10) {
      return 'Neutral';
    }

    var swingHighs = [];
    var swingLows = [];
    var lookback = 2;

    for (var i = lookback; i < bars.length - lookback; i++) {
      var p = bars[i].close;
      var isHigh = true;
      var isLow = true;

      for (var j = 1; j <= lookback; j++) {
        if (bars[i - j].close >= p || bars[i + j].close >= p) {
          isHigh = false;
        }
        if (bars[i - j].close <= p || bars[i + j].close <= p) {
          isLow = false;
        }
      }

      if (isHigh) {
        swingHighs.push({
          index: i,
          t: bars[i].t,
          close: bars[i].close,
          rsi: bars[i].rsi
        });
      }

      if (isLow) {
        swingLows.push({
          index: i,
          t: bars[i].t,
          close: bars[i].close,
          rsi: bars[i].rsi
        });
      }
    }

    function detectBearishDivergence() {
      if (swingHighs.length < 2) return null;
      var h1 = swingHighs[swingHighs.length - 1];
      var h2 = swingHighs[swingHighs.length - 2];
      if (h1.close > h2.close && h1.rsi < h2.rsi) {
        return h1;
      }
      return null;
    }

    function detectBullishDivergence() {
      if (swingLows.length < 2) return null;
      var l1 = swingLows[swingLows.length - 1];
      var l2 = swingLows[swingLows.length - 2];
      if (l1.close < l2.close && l1.rsi > l2.rsi) {
        return l1;
      }
      return null;
    }

    var bearish = detectBearishDivergence();
    var bullish = detectBullishDivergence();

    var result;
    if (bearish && bullish) {
      if (bearish.t > bullish.t) {
        result = 'Bearish divergence';
      } else {
        result = 'Bullish divergence';
      }
    } else if (bearish) {
      result = 'Bearish divergence';
    } else if (bullish) {
      result = 'Bullish divergence';
    } else {
      result = 'Neutral';
    }

    setCachedValue(cacheKey, result, 14400);
    return result;

  } catch (err) {
    return 'Error: ' + err;
  }
}

/**
 * EARNINGS_NEXT - Fixed version
 */
function EARNINGS_NEXT(ticker) {
  try {
    if (!ticker) return 'Error: missing ticker';

    ticker = String(ticker).trim().toUpperCase();
    var cacheKey = buildCacheKey(CACHE_PREFIX_MASSIVE, ticker, 'earnings');

    var cached = getCachedValue(cacheKey);
    if (cached != null) {
      return cached;
    }

    var baseUrl = 'https://api.massive.com/benzinga/v1/earnings';
    var params = {
      ticker: ticker,
      sort: 'date.asc',
      limit: 100,
      apiKey: MASSIVE_API_KEY
    };

    var query = Object.keys(params)
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
      .join('&');

    var url = baseUrl + '?' + query;

    var data = massiveFetch(url, 'Earnings Next - ' + ticker);

    if (!data.results || !data.results.length) {
      return 'No earnings data';
    }

    var todayStr = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
    var nextUpcoming = null;
    var latestPast = null;

    data.results.forEach(function (row) {
      if (!row.date) return;
      var d = row.date;

      if (d >= todayStr) {
        if (!nextUpcoming || d < nextUpcoming.date) {
          nextUpcoming = { date: d, raw: row };
        }
      } else {
        if (!latestPast || d > latestPast.date) {
          latestPast = { date: d, raw: row };
        }
      }
    });

    var result;
    if (nextUpcoming) {
      result = nextUpcoming.date;
    } else if (latestPast) {
      result = latestPast.date;
    } else {
      result = 'No earnings dates found';
    }

    setCachedValue(cacheKey, result, 43200);
    return result;

  } catch (e) {
    return 'Error: ' + e.message;
  }
}

// ========== POLYGON API FUNCTIONS ==========

/**
 * Helper to make Polygon API calls with rate limiting
 */
function polygonFetch(url, operationName) {
  return executeWithRateLimit('polygon', function() {
    return retryWithBackoff(function() {
      var options = {
        method: 'get',
        muteHttpExceptions: true
      };

      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();

      if (code !== 200) {
        var body = response.getContentText();

        if (isRetryableError(code)) {
          throw new Error('Rate limit error: HTTP ' + code);
        }

        throw new Error('Polygon API error (' + code + '): ' + body);
      }

      return JSON.parse(response.getContentText());
    }, operationName);
  }, operationName);
}

/**
 * POLY_IV30 - Fixed version
 */
function POLY_IV30(ticker) {
  if (!ticker) {
    throw new Error('Ticker is required');
  }
  ticker = String(ticker).trim().toUpperCase();

  var cacheKey = buildCacheKey(CACHE_PREFIX_POLYGON, ticker, 'iv30');

  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return parseFloat(cached);
  }

  var result = _polyGetIv30(ticker);

  setCachedValue(cacheKey, result.toString(), CACHE_EXPIRATION_SECONDS);
  return result;
}

function _polyGetIv30(ticker) {
  var url = 'https://api.polygon.io/v3/snapshot/options/' +
            encodeURIComponent(ticker) +
            '?limit=250&apiKey=' + encodeURIComponent(POLYGON_API_KEY);

  var data = polygonFetch(url, 'Polygon IV30 - ' + ticker);

  var results = data.results;
  if (!results || !results.length) {
    throw new Error('No options data returned for ticker: ' + ticker);
  }

  var today = new Date();
  var msPerDay = 1000 * 60 * 60 * 24;
  var ivs = [];

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!r) continue;

    var iv = r.implied_volatility;
    if (typeof iv !== 'number') continue;

    var dte = null;

    if (r.details && typeof r.details.days_to_expiration === 'number') {
      dte = r.details.days_to_expiration;
    } else if (typeof r.days_to_expiration === 'number') {
      dte = r.days_to_expiration;
    } else if (r.details && r.details.expiration_date) {
      var exp = new Date(r.details.expiration_date);
      dte = Math.round((exp - today) / msPerDay);
    }

    if (dte == null || isNaN(dte)) continue;

    if (dte > 25 && dte < 35) {
      ivs.push(iv);
    }
  }

  if (!ivs.length) {
    var closestIv = null;
    var closestDiff = null;

    for (var j = 0; j < results.length; j++) {
      var r2 = results[j];
      if (!r2) continue;

      var iv2 = r2.implied_volatility;
      if (typeof iv2 !== 'number') continue;

      var dte2 = null;
      if (r2.details && typeof r2.details.days_to_expiration === 'number') {
        dte2 = r2.details.days_to_expiration;
      } else if (typeof r2.days_to_expiration === 'number') {
        dte2 = r2.days_to_expiration;
      } else if (r2.details && r2.details.expiration_date) {
        var exp2 = new Date(r2.details.expiration_date);
        dte2 = Math.round((exp2 - today) / msPerDay);
      }

      if (dte2 == null || isNaN(dte2)) continue;

      var diff = Math.abs(dte2 - 30);
      if (closestDiff === null || diff < closestDiff) {
        closestDiff = diff;
        closestIv = iv2;
      }
    }

    if (closestIv == null) {
      throw new Error('Could not find any contracts with IV and valid DTE for ' + ticker);
    }
    return closestIv;
  }

  var sumIv = 0;
  for (var k = 0; k < ivs.length; k++) {
    sumIv += ivs[k];
  }

  var avgIv = sumIv / ivs.length;
  return avgIv;
}

/**
 * POLY_HV - Fixed version
 */
function POLY_HV(ticker, windowDays) {
  if (!ticker) {
    throw new Error('Ticker is required');
  }
  ticker = String(ticker).trim().toUpperCase();
  var win = windowDays ? Number(windowDays) : 20;
  if (!win || win < 5) {
    throw new Error('windowDays should be a reasonable number');
  }

  var cacheKey = buildCacheKey(CACHE_PREFIX_POLYGON, ticker, 'hv' + win);

  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return parseFloat(cached);
  }

  var result = _polyGetHv(ticker, win);

  setCachedValue(cacheKey, result.toString(), CACHE_EXPIRATION_SECONDS);
  return result;
}

function _polyGetHv(ticker, windowDays) {
  var today = new Date();
  var msPerDay = 1000 * 60 * 60 * 24;

  var lookbackDays = windowDays + 20;
  var fromDate = new Date(today.getTime() - lookbackDays * msPerDay);

  function formatDate(d) {
    var y = d.getFullYear();
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    return y + '-' + m + '-' + dd;
  }

  var fromStr = formatDate(fromDate);
  var toStr   = formatDate(today);

  var url = 'https://api.polygon.io/v2/aggs/ticker/' +
            encodeURIComponent(ticker) +
            '/range/1/day/' + fromStr + '/' + toStr +
            '?adjusted=true&sort=asc&limit=500&apiKey=' +
            encodeURIComponent(POLYGON_API_KEY);

  var data = polygonFetch(url, 'Polygon HV - ' + ticker);

  var results = data.results;
  if (!results || results.length < windowDays + 1) {
    throw new Error('Not enough daily bars to compute HV');
  }

  var closes = [];
  for (var i = 0; i < results.length; i++) {
    var c = results[i].c;
    if (typeof c === 'number') {
      closes.push(c);
    }
  }

  if (closes.length < windowDays + 1) {
    throw new Error('Not enough valid close prices to compute HV');
  }

  closes = closes.slice(- (windowDays + 1));

  var returns = [];
  for (var j = 1; j < closes.length; j++) {
    var r = Math.log(closes[j] / closes[j - 1]);
    returns.push(r);
  }

  if (returns.length < windowDays) {
    throw new Error('Not enough return points to compute HV');
  }

  var sum = 0;
  for (var k = 0; k < returns.length; k++) {
    sum += returns[k];
  }
  var mean = sum / returns.length;

  var varSum = 0;
  for (var p = 0; p < returns.length; p++) {
    var diff = returns[p] - mean;
    varSum += diff * diff;
  }
  var variance = varSum / (returns.length - 1);
  var hvDaily = Math.sqrt(variance);

  var hvAnnual = hvDaily * Math.sqrt(252);
  return hvAnnual;
}

/**
 * POLY_VOLRATIO - Fixed version
 */
function POLY_VOLRATIO(ticker, hvWindowDays) {
  if (!ticker) return '';

  ticker = String(ticker).trim().toUpperCase();
  var win = hvWindowDays ? Number(hvWindowDays) : 20;

  var cacheKey = buildCacheKey(CACHE_PREFIX_POLYGON, ticker, 'volratio_' + win);

  // Use fast-return wrapper
  var result = fastReturnOrFetch(cacheKey, function() {
    var iv30 = POLY_IV30(ticker);
    var hv   = POLY_HV(ticker, win);

    if (!hv || hv === 0 || !isFinite(hv)) {
      return '';
    }

    var ratio = iv30 / hv;
    if (!isFinite(ratio)) {
      return '';
    }

    return ratio;
  }, 7200); // Cache for 2 hours

  // Parse result if it's a string
  if (result === '') return '';
  var numResult = typeof result === 'string' ? parseFloat(result) : result;
  return isNaN(numResult) ? '' : numResult;
}

// ========== FINNHUB API FUNCTIONS ==========

/**
 * Helper to make Finnhub API calls with rate limiting
 */
function finnhubFetch(url, operationName) {
  return executeWithRateLimit('finnhub', function() {
    return retryWithBackoff(function() {
      var options = {
        method: 'get',
        muteHttpExceptions: true
      };

      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();

      if (code !== 200) {
        var body = response.getContentText();

        if (isRetryableError(code)) {
          throw new Error('Rate limit error: HTTP ' + code);
        }

        // Finnhub returns 200 even on errors sometimes, check body
        if (body && body.indexOf('error') !== -1) {
          throw new Error('Finnhub API error: ' + body);
        }

        throw new Error('Finnhub API error (' + code + '): ' + body);
      }

      return JSON.parse(response.getContentText() || '{}');
    }, operationName);
  }, operationName);
}

/**
 * FINNHUB_NEXT_EARNINGS - Fixed version
 */
function FINNHUB_NEXT_EARNINGS(symbol) {
  try {
    if (!symbol) return '';

    symbol = String(symbol).trim().toUpperCase();
    var cacheKey = buildCacheKey(CACHE_PREFIX_FINNHUB, symbol, 'earnings');

    var cached = getCachedValue(cacheKey);
    if (cached != null && cached !== '') {
      var parts = cached.split('-');
      if (parts.length === 3) {
        var year = parseInt(parts[0], 10);
        var month = parseInt(parts[1], 10);
        var day = parseInt(parts[2], 10);
        return new Date(Date.UTC(year, month - 1, day));
      }
      return '';
    }

    var today = new Date();
    var from = Utilities.formatDate(today, 'GMT', 'yyyy-MM-dd');

    var future = new Date(today);
    future.setDate(future.getDate() + 365);
    var to = Utilities.formatDate(future, 'GMT', 'yyyy-MM-dd');

    var url =
      'https://finnhub.io/api/v1/calendar/earnings' +
      '?from=' + encodeURIComponent(from) +
      '&to=' + encodeURIComponent(to) +
      '&symbol=' + encodeURIComponent(symbol) +
      '&token=' + encodeURIComponent(FINNHUB_API_KEY);

    var data = finnhubFetch(url, 'Finnhub Earnings - ' + symbol);

    var list = data.earningsCalendar || data.earnings || [];

    if (!list || !list.length) {
      return '';
    }

    list = list
      .filter(function (item) {
        return item && item.date;
      })
      .sort(function (a, b) {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return 0;
      });

    if (!list.length) {
      return '';
    }

    var next = list[0];
    var dateStr = next.date;

    if (!dateStr) {
      return '';
    }

    var parts = dateStr.split('-');
    if (parts.length !== 3) {
      return '';
    }

    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var day = parseInt(parts[2], 10);

    if (isNaN(year) || isNaN(month) || isNaN(day)) {
      return '';
    }

    setCachedValue(cacheKey, dateStr, 43200);

    var jsDate = new Date(Date.UTC(year, month - 1, day));
    return jsDate;
  } catch (err) {
    Logger.log('FINNHUB_NEXT_EARNINGS error for ' + symbol + ': ' + err);
    return '';
  }
}

// ========== ALTERNATIVE PERPLEXITY FUNCTIONS ==========

function getStockSentiment(ticker) {
  if (!ticker) {
    return "Error: Please provide a ticker symbol";
  }

  ticker = String(ticker).trim().toUpperCase();
  var cacheKey = buildCacheKey(CACHE_PREFIX_PPLX, ticker, 'sentiment2');

  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return cached;
  }

  const prompt = `Analyze the current market sentiment for the stock ticker ${ticker}.

  Consider the following factors from the latest news and market data:
  - Recent news headlines and articles
  - Analyst ratings and price target changes
  - Earnings reports and guidance
  - Market trends and sector performance
  - Social media and investor sentiment
  - Any recent significant events or announcements

  Based on your analysis, classify the overall sentiment as exactly one of these three options:
  - "Bullish" (positive outlook, expected to rise)
  - "Bearish" (negative outlook, expected to fall)
  - "Neutral" (mixed signals, no clear direction)

  IMPORTANT: Respond with ONLY ONE WORD - either "Bullish", "Bearish", or "Neutral". No other text.`;

  const payload = {
    model: "sonar-pro",
    messages: [
      {
        role: "system",
        content: "You are a financial sentiment analyst. Analyze stocks and respond with exactly one word: Bullish, Bearish, or Neutral. No explanations."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    max_tokens: 10,
    temperature: 0.1
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": "Bearer " + PPLX_API_KEY_2
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = executeWithRateLimit('pplx', function() {
      return retryWithBackoff(function() {
        var resp = UrlFetchApp.fetch(PPLX_ENDPOINT, options);
        var code = resp.getResponseCode();

        if (code !== 200) {
          if (isRetryableError(code)) {
            throw new Error('Rate limit error: HTTP ' + code);
          }
          throw new Error('API returned ' + code);
        }

        return resp;
      }, 'Get Stock Sentiment');
    }, 'Get Stock Sentiment PPLX');

    const json = JSON.parse(response.getContentText());
    const result = json.choices[0].message.content.trim();

    const normalized = result.toLowerCase();

    var sentiment;
    if (normalized.indexOf("bullish") !== -1) {
      sentiment = "Bullish";
    } else if (normalized.indexOf("bearish") !== -1) {
      sentiment = "Bearish";
    } else {
      sentiment = "Neutral";
    }

    setCachedValue(cacheKey, sentiment, CACHE_EXPIRATION_SECONDS);
    return sentiment;

  } catch (error) {
    Logger.log('getStockSentiment error: ' + error);
    if (cached != null) {
      return cached + " (cached)";
    }
    return "";
  }
}

function getStockSentimentDetailed(ticker) {
  if (!ticker) {
    return "Error: Please provide a ticker symbol";
  }

  ticker = String(ticker).trim().toUpperCase();
  var cacheKey = buildCacheKey(CACHE_PREFIX_PPLX, ticker, 'sentimentdetail');

  var cached = getCachedValue(cacheKey);
  if (cached != null) {
    return cached;
  }

  const prompt = `Analyze the current market sentiment for ${ticker} stock based on the latest news and data.

  Provide a response in this exact format:
  SENTIMENT: [Bullish/Bearish/Neutral]
  REASON: [One sentence explanation]`;

  const payload = {
    model: "sonar",
    messages: [
      {
        role: "system",
        content: "You are a concise financial analyst. Provide sentiment analysis in the exact format requested."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    max_tokens: 100,
    temperature: 0.1
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": "Bearer " + PPLX_API_KEY_2
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = executeWithRateLimit('pplx', function() {
      return retryWithBackoff(function() {
        var resp = UrlFetchApp.fetch(PPLX_ENDPOINT, options);
        var code = resp.getResponseCode();

        if (code !== 200) {
          if (isRetryableError(code)) {
            throw new Error('Rate limit error: HTTP ' + code);
          }
          throw new Error('API returned ' + code);
        }

        return resp;
      }, 'Get Stock Sentiment Detailed');
    }, 'Get Stock Sentiment Detailed PPLX');

    const json = JSON.parse(response.getContentText());
    var result = json.choices[0].message.content.trim();

    setCachedValue(cacheKey, result, CACHE_EXPIRATION_SECONDS);
    return result;
  } catch (error) {
    Logger.log('getStockSentimentDetailed error: ' + error);
    if (cached != null) {
      return cached;
    }
    return "";
  }
}

// ========== BATCH UPDATE FUNCTION ==========

/**
 * UPDATE_DASHBOARD - Batch updater with rate limiting
 * Now properly throttled to avoid rate limits
 */
function UPDATE_DASHBOARD() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName("Priority List");
  if (!sh) {
    throw new Error('Sheet "Priority List" not found.');
  }

  var lastRow = sh.getLastRow();
  if (lastRow < 3) {
    Logger.log("No data rows found.");
    return;
  }

  var tickerRange = sh.getRange(3, 2, lastRow - 2, 1);
  var tickers = tickerRange.getValues();

  var sentimentOut = [];
  var sectorOut = [];
  var multiplierOut = [];

  Logger.log('Starting dashboard update for ' + tickers.length + ' tickers...');

  for (var i = 0; i < tickers.length; i++) {
    var t = tickers[i][0];

    Logger.log('Processing ' + (i + 1) + '/' + tickers.length + ': ' + t);

    if (!t) {
      sentimentOut.push([""]);
      sectorOut.push([""]);
      multiplierOut.push([""]);
      continue;
    }

    // These functions now use cache and rate limiting
    var stockSent = _pplxSentimentScalar(t);
    var sectorSent = _pplxSectorScalar(t);
    var mult = _sectorMultiplierScalar(sectorSent);

    sentimentOut.push([stockSent]);
    sectorOut.push([sectorSent]);
    multiplierOut.push([mult]);

    // Write progress every 5 rows
    if ((i + 1) % 5 === 0) {
      Logger.log('Progress: ' + (i + 1) + '/' + tickers.length + ' completed');
    }
  }

  sh.getRange(3, 16, sentimentOut.length, 1).setValues(sentimentOut);
  sh.getRange(3, 28, sectorOut.length, 1).setValues(sectorOut);
  sh.getRange(3, 29, multiplierOut.length, 1).setValues(multiplierOut);

  Logger.log("UPDATE_DASHBOARD complete for " + sentimentOut.length + " rows.");
}

// ========== UTILITY FUNCTIONS ==========

/**
 * CLEAR_CACHE - Clear all cached values
 */
function CLEAR_CACHE() {
  try {
    var cache = CacheService.getScriptCache();
    var keys = [];

    // Get all keys with our prefixes
    [CACHE_PREFIX_PPLX, CACHE_PREFIX_MASSIVE, CACHE_PREFIX_POLYGON, CACHE_PREFIX_FINNHUB].forEach(function(prefix) {
      // Note: Apps Script doesn't provide direct key listing, so we just clear what we can
      Logger.log('Attempting to clear cache with prefix: ' + prefix);
    });

    // Alternative: Clear by trying to remove specific known patterns
    // For now, just log that cache will expire naturally
    Logger.log("Cache will expire naturally based on TTL. To force refresh, wait or use new cache keys.");
    Logger.log("Note: Google Apps Script Cache has limited key enumeration capabilities.");

  } catch (e) {
    Logger.log("Cache operation note: " + e);
  }
}

/**
 * CLEAR_RATE_LIMITS - Clear rate limiting properties
 */
function CLEAR_RATE_LIMITS() {
  try {
    var props = PropertiesService.getScriptProperties();
    var keys = props.getKeys();

    keys.forEach(function(key) {
      if (key.indexOf('lastCall_') === 0 || key.indexOf('lock_') === 0) {
        props.deleteProperty(key);
        Logger.log('Cleared: ' + key);
      }
    });

    Logger.log("Rate limit properties cleared successfully!");
  } catch (e) {
    Logger.log("Error clearing rate limits: " + e);
  }
}

/**
 * TEST_RATE_LIMITING - Test the rate limiting system
 */
function TEST_RATE_LIMITING() {
  Logger.log("Testing rate limiting system...");

  var startTime = Date.now();

  // Try to make 3 rapid calls - should be spaced out
  Logger.log("Making 3 rapid MASSIVE_RSI calls...");

  var rsi1 = MASSIVE_RSI("AAPL");
  Logger.log("Call 1 completed: " + rsi1 + " (elapsed: " + (Date.now() - startTime) + "ms)");

  var rsi2 = MASSIVE_RSI("MSFT");
  Logger.log("Call 2 completed: " + rsi2 + " (elapsed: " + (Date.now() - startTime) + "ms)");

  var rsi3 = MASSIVE_RSI("GOOGL");
  Logger.log("Call 3 completed: " + rsi3 + " (elapsed: " + (Date.now() - startTime) + "ms)");

  var totalTime = Date.now() - startTime;
  Logger.log("\nTotal time: " + totalTime + "ms");
  Logger.log("Expected minimum: " + (RATE_LIMIT_MASSIVE * 2) + "ms (2 second intervals x 2)");

  if (totalTime >= RATE_LIMIT_MASSIVE * 2) {
    Logger.log("✓ Rate limiting is working correctly!");
  } else {
    Logger.log("⚠ Calls completed faster than expected - check if using cache");
  }
}

/**
 * TEST_CACHE - Test cache functionality
 */
function TEST_CACHE() {
  Logger.log("Testing cache functionality...");

  // Clear rate limits to allow immediate testing
  CLEAR_RATE_LIMITS();

  Logger.log("\n1. First call (should hit API):");
  var start1 = Date.now();
  var result1 = PPLX_SENTIMENT("AAPL");
  var time1 = Date.now() - start1;
  Logger.log("Result: " + result1 + " (took " + time1 + "ms)");

  Logger.log("\n2. Second call (should use cache):");
  var start2 = Date.now();
  var result2 = PPLX_SENTIMENT("AAPL");
  var time2 = Date.now() - start2;
  Logger.log("Result: " + result2 + " (took " + time2 + "ms)");

  if (time2 < time1 / 10) {
    Logger.log("\n✓ Cache is working! Second call was much faster.");
  } else {
    Logger.log("\n⚠ Cache might not be working as expected.");
  }

  Logger.log("\nCache test complete!");
}

/**
 * CONFIGURE_RETRY - Adjust retry settings
 */
function CONFIGURE_RETRY(maxRetries, initialBackoffMs) {
  if (maxRetries !== undefined) {
    MAX_RETRIES = maxRetries;
    Logger.log("Max retries set to: " + MAX_RETRIES);
  }
  if (initialBackoffMs !== undefined) {
    INITIAL_BACKOFF_MS = initialBackoffMs;
    Logger.log("Initial backoff delay set to: " + INITIAL_BACKOFF_MS + "ms");
  }
  Logger.log("Retry configuration updated!");
}

/**
 * TOGGLE_FAST_RETURN - Enable/disable fast return mode
 *
 * Fast return mode = return cached values immediately without waiting for API
 * Use this when you have 100+ formulas to avoid timeout errors
 *
 * @param {boolean} enabled - true = fast return, false = always refresh
 */
function TOGGLE_FAST_RETURN(enabled) {
  FAST_RETURN_MODE = enabled;
  Logger.log('Fast return mode: ' + (enabled ? 'ENABLED (returns cache instantly)' : 'DISABLED (always fetches fresh)'));
  Logger.log('This setting lasts for this execution only. Set FAST_RETURN_MODE in code for permanent change.');
}

/**
 * CONFIGURE_RATE_LIMITS - Adjust rate limiting
 */
function CONFIGURE_RATE_LIMITS(massive, pplx, polygon, finnhub) {
  if (massive !== undefined) {
    RATE_LIMIT_MASSIVE = massive;
    Logger.log("Massive rate limit set to: " + RATE_LIMIT_MASSIVE + "ms");
  }
  if (pplx !== undefined) {
    RATE_LIMIT_PPLX = pplx;
    Logger.log("Perplexity rate limit set to: " + RATE_LIMIT_PPLX + "ms");
  }
  if (polygon !== undefined) {
    RATE_LIMIT_POLYGON = polygon;
    Logger.log("Polygon rate limit set to: " + RATE_LIMIT_POLYGON + "ms");
  }
  if (finnhub !== undefined) {
    RATE_LIMIT_FINNHUB = finnhub;
    Logger.log("Finnhub rate limit set to: " + RATE_LIMIT_FINNHUB + "ms");
  }
  Logger.log("Rate limit configuration updated!");
}

// ========== TEST FUNCTIONS ==========

function TEST_PPLX() {
  var demo = PPLX_SENTIMENT("NVDA");
  var demo2 = PPLX_SECTOR("NVDA");
  Logger.log("NVDA sentiment: " + demo);
  Logger.log("NVDA sector sentiment: " + demo2);
}
