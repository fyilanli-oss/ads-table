# Ads Table Meta — Replit OAuth MVP

## Replit setup
1. Upload/extract this zip into a Replit Node.js app.
2. Add Replit Secrets:
   - META_APP_ID
   - META_APP_SECRET
   - META_REDIRECT_URI
   - SESSION_SECRET

META_REDIRECT_URI must be:
https://YOUR-REPLIT-APP.replit.dev/auth/meta/callback

3. Add the same redirect URI in Meta Developer app → Facebook Login valid OAuth redirect URIs.
4. Run:
npm install
npm start

Safety: ads_read only. No campaign edits.
