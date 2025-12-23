# Quick Start Guide - Deploy Fixed Code

## 🚀 5-Minute Setup

### Step 1: Open Your Google Sheet
1. Open the Proflex Dashboard spreadsheet
2. Click **Extensions** → **Apps Script**

### Step 2: Backup Current Code (Optional)
1. Select all code in the editor (Cmd+A / Ctrl+A)
2. Copy to a text file as backup
3. Save as `backup_old_code.gs`

### Step 3: Deploy Fixed Code
1. **Delete all existing code** in the Apps Script editor
2. Open the file: `/Users/parthkhanna/Finance/proflex_dashboard_fixed.gs`
3. **Copy everything** (Cmd+A, Cmd+C)
4. **Paste into Apps Script editor** (Cmd+V)
5. Click **💾 Save** (or Cmd+S)
6. Rename project to "Proflex Dashboard v3 Fixed" (optional)

### Step 4: Add Your API Keys
**IMPORTANT:** Replace the placeholders in lines 32-38 with your actual API keys:

```javascript
const PPLX_API_KEY = "YOUR_PERPLEXITY_API_KEY_HERE";         // Replace with your key
const PPLX_API_KEY_2 = "YOUR_PERPLEXITY_API_KEY_2_HERE";     // Replace with your key
const MASSIVE_API_KEY = 'YOUR_MASSIVE_API_KEY_HERE';         // Replace with your key
const POLYGON_API_KEY = 'YOUR_POLYGON_API_KEY_HERE';         // Usually same as Massive
const FINNHUB_API_KEY = 'YOUR_FINNHUB_API_KEY_HERE';         // Replace with your key
```

### Step 5: Test the Fix
1. In Apps Script editor, select **TEST_RATE_LIMITING** from the function dropdown
2. Click **▶ Run**
3. Click **Review Permissions** if prompted
4. Authorize the script
5. Check **View** → **Logs** - should see successful rate-limited calls

### Step 6: Return to Spreadsheet
1. Go back to your Google Sheet
2. The formulas should now work without errors
3. **First load will be slow** (~60 seconds for 30 tickers)
4. **Subsequent loads will be instant** (cached)

---

## ✅ Verification Checklist

- [ ] Code copied and saved in Apps Script
- [ ] API keys verified
- [ ] TEST_RATE_LIMITING runs successfully
- [ ] No #ERROR cells in spreadsheet
- [ ] Formulas populate (may take 1-2 minutes first time)
- [ ] Second refresh is instant (cache working)

---

## 🔥 If You Get Errors

### Authorization Error
**Solution:** Apps Script → Run any function → Authorize

### Still Getting 429 Errors
**Solution:** Run this in Apps Script:
```javascript
CONFIGURE_RATE_LIMITS(3000, 2500, 2000, 2000)
```
(Increases delays to 3s, 2.5s, 2s, 2s)

### Formulas Not Updating
**Solution:** Run this in Apps Script:
```javascript
CLEAR_RATE_LIMITS()
CLEAR_CACHE()
```

### Cells Show "Error: ..."
**This is actually OK!** Better than #ERROR
- Check what the error message says
- Usually means API returned no data for that ticker
- Or ticker symbol is invalid

---

## 📊 What to Expect

### First Time Running (No Cache)
```
⏱ Time: ~60-90 seconds for 30 tickers
✅ Result: All cells populate successfully
🔄 Rate: ~2 seconds per API call (Massive API)
```

### Second Time Running (With Cache)
```
⏱ Time: Instant (< 1 second)
✅ Result: All cells populate from cache
🔄 Rate: No API calls needed
```

### When Cache Expires (After 2-6 hours)
```
⏱ Time: ~60-90 seconds again
✅ Result: Fresh data from APIs
🔄 Rate: Cache refreshes automatically
```

---

## 🎯 Key Changes from Old Code

| Feature | Old Code | New Code |
|---------|----------|----------|
| **Rate Limiting** | ❌ None | ✅ 2s per Massive call |
| **Concurrent Calls** | ❌ Unlimited | ✅ 1 at a time per API |
| **Error Handling** | ❌ #ERROR cells | ✅ Returns cache or empty |
| **Retry Logic** | ⚠️ Partial | ✅ All APIs |
| **Distributed Locks** | ❌ None | ✅ ScriptProperties |
| **Stale Cache Fallback** | ❌ None | ✅ Returns old data on error |

---

## 💡 Pro Tips

1. **First load after midnight?** Cache expired, will be slow
2. **Need instant updates?** Run `CLEAR_CACHE()` first
3. **Adding new tickers?** They'll be slow first time, then cached
4. **Debugging?** Check Apps Script logs: View → Logs
5. **Rate limit too strict?** Increase intervals with `CONFIGURE_RATE_LIMITS()`

---

## 📞 Support

If issues persist after following this guide:

1. Check logs: Apps Script → View → Logs
2. Look for `[RETRY]` or `[RATE LIMIT]` messages
3. Note the exact error message
4. Check which function is failing
5. Verify API keys are still valid

---

## 🎉 Success Criteria

You'll know it's working when:

✅ No red #ERROR cells in your spreadsheet
✅ First load takes ~60 seconds (this is normal!)
✅ Second load is instant
✅ Logs show "[RATE LIMIT] Waiting Xms" messages
✅ Data populates successfully for all tickers

---

**That's it! Your rate limit issues should be completely resolved.** 🎊

The tradeoff is slower initial load, but zero errors and instant cached responses afterward.
