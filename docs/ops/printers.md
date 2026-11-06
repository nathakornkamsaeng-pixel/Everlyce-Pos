# Checking a printer profile

No seeded profile has been measured against a physical printer. Every row in
`server/src/printing/profiles.js` has `quirks.verified: false` for that reason.
`genericProfile()` in `server/src/printing/escpos.js` is the same kind of claim
for a model that is not in the list: 80mm paper, 48 columns, unverified, and no
Thai code-page number.

Paper width and the usual column count (48 at 80mm, 32 at 58mm, 203dpi, font A)
are the part that is likely to be right. The `ESC t` number that selects Thai
is firmware dependent. It is unset on purpose. A wrong number prints mojibake.

## What to do with a unit on the counter

1. Add the printer in the shop admin and send the test print. The bytes are
   real ESC/POS. Count the columns on the paper and check the width (80mm or
   58mm).
2. Print a line of Thai. If it is wrong, do not guess a code page in the
   driver. Set `quirks.codePage` on that model's row only after you have seen
   which `ESC t` value that firmware actually uses. The driver reads
   `quirks.codePage` and otherwise keeps its documented default.
3. When the width, the column count, the cut, and the drawer match the unit,
   set `quirks.verified` to `true` on that row and replace `quirks.source` with
   a note of what you measured and when. Restart the server. Saving the printer
   again copies `verified` from the catalogue onto the shop's printer.
4. Leave `verified` false if any of those checks failed or were not done. A
   profile that says it was checked when it was not is worse than one that
   says it was not.

Do not flip the flag from the till. The shop UI shows the catalogue value. It
does not invent a hardware check.
