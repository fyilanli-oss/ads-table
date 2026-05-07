# AdsTable Meta Recovery Build

This build restores the working Meta integration only.

Files:
- server.js
- package.json
- vercel.json
- public/index.html
- README.md
- .env.example

Required Vercel env:
- SESSION_SECRET
- META_APP_ID
- META_APP_SECRET
- META_REDIRECT_URI=https://app.adstable.app/auth/meta/callback

Test:
- https://app.adstable.app
- https://app.adstable.app/auth/meta
- https://app.adstable.app/api/meta/status
- https://app.adstable.app/api/meta/adaccounts
