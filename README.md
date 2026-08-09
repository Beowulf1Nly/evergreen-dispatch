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

## Your passphrase

It lives in `private/passphrase.txt` on your PC. `.gitignore` keeps that folder out
of the repo, and the build script deliberately never prints it to the terminal.

Lost it? There's no recovery — delete `private/passphrase.txt`, run the build again
to generate a new one, and hit "Forget passphrase on this device" on any phone or PC
that had the old one cached.

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
