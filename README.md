# JARVIS V6 — Device Calling (Vercel)

This is the **standalone browser calling interface** for JARVIS V6. It is not the desktop assistant and does not include PMX assets.

## Deploy

1. Open Vercel → Add New → Project → import this repository.
2. Choose **Framework Preset: Other**.
3. Use **Root Directory: .**, **Build Command: none**, **Output Directory: .**.
4. Deploy and open `https://YOUR-DOMAIN.vercel.app/calls.html`.

## Firebase setup

- Open Firebase Console → Authentication → Sign-in method → enable Google.
- In Authentication → Settings → Authorized domains, add your Vercel host (without `https://`).
- Confirm the Firebase Realtime Database for the project in `firebase-config.json` is enabled.
- **Protect data with Realtime Database security rules.** Each signed-in user should only be able to read and write their own `users/{uid}` subtree. Test rules before releasing publicly. Do not replace rules for your existing desktop assistant blindly.
- `firebase-config.json` contains Firebase **web client settings**, not a service account secret. Since this repository is **public**, secure database rules and API restrictions are particularly important. Never commit service account keys, passwords, or `.env` files.

## Call test

1. Open `/calls.html` in Chrome and Edge (or separate browser profiles), or use a laptop and phone.
2. Sign into the **same** Google account in both.
3. Register two distinct browser devices, e.g. `Laptop` and `Phone`.
4. Select the other online device → **Call** → **Answer call**.
5. Grant microphone permissions on each browser. When testing on one computer, use headphones to prevent feedback.

## Limits

- Both browsers must stay open and online. Calls are **internet-based**—not Bluetooth, and there is no 10 m range limitation.
- Android background ringing when the browser is closed requires a separate Android application and push integration.
- WebRTC uses public STUN only in this prototype. For reliable calls through mobile networks, restrictive firewalls, or symmetric NAT, configure a trusted TURN relay.
- Vercel serves the HTTPS page. It does not keep the Windows desktop JARVIS running while the computer is shut down.
- This static deployment is **not proof** that live WebRTC/Firebase calling has been successfully tested.

## Troubleshooting

- `404`: Check root contains `calls.html` and `app.js`.
- `auth/unauthorized-domain`: Add Vercel domain in Firebase Authentication.
- `permission_denied`: Review Firebase Database rules; do not open all data to everyone.
- No audio: Confirm microphone permissions/HTTPS and TURN availability on restrictive networks.
