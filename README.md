# Evergreen Dispatch

Daily work board for Evergreen Lawn Care, built from Pocket voice notes.

The repo is public so GitHub Pages will serve it for free — so **the board data is
encrypted before it's committed**. What's published is ciphertext plus the page
that unlocks it in your browser. Client names, addresses, and payroll never appear
in the repo in readable form.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The app — unlock screen, then the board |
| `data.enc.json` | The board, AES-256-GCM encrypted. Safe to commit. |
| `tools/encrypt.mjs` | Build step: plaintext → ciphertext |
| `private/` | **Never committed.** Plaintext board + your passphrase. |

## The key is in two parts

| Part | Where | Role |
|---|---|---|
| **PIN** | `private/pin.txt` | The 4 digits you type |
| **Device key** | `private/devicekey.txt` | 128 bits, installed once per device |

**Both are required.** This matters: a 4-digit PIN on its own could never protect a
ciphertext published to a public repo — all 10,000 combinations fall in well under a
second offline. The device key is what actually carries the entropy, so the PIN can
stay short enough to thumb in at a stoplight.

The device key reaches a phone or PC through the URL fragment in
`private/setup-link.txt`. Fragments are never sent to a server, so it never touches
GitHub. The page stores it and strips it from the address bar on first load.

Set up a new device: open the setup link on it once, then use the PIN forever after.

Lost the device key? Delete `private/devicekey.txt`, re-run the build for a fresh one,
and open the new setup link on each device. Old devices stop working, which is also
how you revoke one.

## Updating the board

```bash
node tools/encrypt.mjs
git add -A && git commit -m "Update board" && git push
```

Pages redeploys in under a minute. Ask Claude to rebuild `private/board.json` from
Pocket first — that's the part that does the consolidation.

## Security, honestly

- Encryption is real: PBKDF2-SHA256 at 310k iterations into AES-256-GCM, decrypted
  client-side. Someone who finds the URL sees noise.
- The passphrase is cached in `localStorage` so you're not retyping it in the truck.
  That's a deliberate trade — anyone holding your *unlocked* phone can open the board,
  same as your email.
- `noindex` is set, but treat that as tidiness, not protection. The encryption is
  what's actually doing the work.
