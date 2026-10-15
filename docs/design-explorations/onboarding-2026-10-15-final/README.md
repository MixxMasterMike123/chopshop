# Kom igång — the decided flow, rendered (2026-10-15)

The screens of `docs/cf-port/CP10_OB_DESIGN.md` on Mikael's four decisions (platform sets the type at invitation, digital = "kommer senare", owner requests and platform publishes, platform assigns the address), in the visual language of the 2026-10-14 mocks (same tokens, Nattfjäril / Nora, Nord). `final.html?s=<screen>` renders one screen; `shared.css` is the token file. The PNG renders (1440×900 @2x) live outside git in `~/chopshop-export/onboarding-mocks-2026-10-14/final-2026-10-15/`.

| Screen | What it shows |
|---|---|
| `00-konsol-ny-butik` | The platform console's "Ny butik": name, assigned address, the three-way type with digital disabled ("Kommer senare"), owner's e-mail |
| `00-losenord` | The password page naming the shop and the six steps |
| `01-din-butik` | Step 1: the gates sentence, name, type + address read-only, logo, colour; placeholder storefront |
| `02-valj-utseende` | Step 2: Nord/Sport, headline, one line; the hero fills in |
| `03-pod-designa-tshirt` | Step 3, POD: motif with the frame verdict, garments with Inköp, colours, price with "du får ca" |
| `03-pod-inlagd-granskas` | Step 3, POD after save: review is a waiting state; the owner's draft preview shows the held product with its ribbon |
| `03-varor-ladda-upp-produkt` | Step 3, fysiska varor: image, name, description, price, stock, delivery; the shop's nav and hero say varor |
| `04-uppgifter-och-villkor` | Step 4: seller category, identity (org nr = personnummer for enskild firma, explained), VAT, return address, platform support e-mail read-only, platform terms box; the generated köpvillkor live on the right |
| `05-stripe-*` | Step 5, the four states: inte påbörjat / granskar / behöver mer / klart. Our page never asks for personnummer or bank; the money example is three lines on the real product |
| `06-granska-och-begar` | Step 6: every step with who holds it (Klart / Granskas av Stripe / Granskas av ChopShop / Behöver göras av dig) and "Begär publicering" |
| `06-vi-forbereder` | After the request: timestamp, what is left and who holds it, "Till adminen" |
| `07-oppen-for-kop` | The ending once the platform has published: link, copy, open, to the admin, three next steps (QR and the Instagram image are OB-3, after launch) |

Made with the impeccable skill; one batched inspection round (four defects fixed), one confirmation round.
