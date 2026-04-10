# Elegant Redesign — Black & Gold Classic (Feestelijk)

## Samenvatting

Visuele upgrade van de muziek request website van het huidige neon/party thema naar een elegant Black & Gold Classic thema. Het doel is een professionelere, tijdloze uitstraling die toch feestelijk aanvoelt. Beide publieke pagina's (stempagina en setlist big screen) krijgen gelijke aandacht.

## Design Richting

**Sfeer:** Elegant/premium met warmte — zwart, goud, rosé. Geen neon, wel feestelijk.

**Animaties:** Subtiel — zachte fades, hover-transities, shimmer op actieve elementen. Geen spotlights, particles of knipperende effecten.

## Kleurenpalet

| Rol | Kleur | Hex |
|-----|-------|-----|
| Achtergrond | Puur zwart | `#0a0a0a` |
| Kaarten/panels | Donkergrijs | `#111111` |
| Hover/active | Licht donkergrijs | `#1a1a1a` |
| Primair accent | Goud | `#c9a84c` |
| Secundair accent | Rosé/champagne | `#d4a0a0` |
| Licht accent | Champagne | `#e8d5a3` |
| Tekst primair | Warm wit | `#f5f0e8` |
| Tekst secundair | Warm grijs | `#8a8070` |
| Borders | Goud transparant | `rgba(201,168,76,0.15)` |

## Typografie

- **Koppen:** Playfair Display (serif), bold. Fallback: Georgia, Times New Roman.
- **Labels:** System sans-serif, klein, uppercase, wijd gespatieerd (letter-spacing 0.3em+), in goud.
- **Body/interface:** Inter of system-ui sans-serif. Goed leesbaar op alle schermformaten.
- **Nummers/posities:** Playfair Display serif, bold, in gedempte goud.

## Achtergrond

- Band-foto achtergrond **blijft**, maar veel donkerder en warmer:
  - Hogere blur (16-20px)
  - Donkerdere overlay: `linear-gradient(180deg, rgba(40,30,15,0.9), rgba(10,10,10,0.97) 60%)`
  - Saturatie verlaagd
- Subtiele warme ambient glow van bovenaf: `radial-gradient(ellipse, rgba(201,168,76,0.07), transparent 70%)`
- Geen spotlight beams, geen particles

## Animaties & Effecten

Wat **verdwijnt:**
- Stage light beams (sweepA/B/C/D animaties)
- Particle canvas
- Neon glow text-shadows
- logoGlow animatie
- timerPulse met scale-effecten

Wat **blijft/nieuw:**
- Zachte fade-in bij laden (opacity 0 → 1, translateY, ~0.4s)
- Subtiele hover-transities op song cards (achtergrondkleur, border, ~0.3s ease)
- Shimmer-effect op "Nu Live" hero blok (zachte gradient sweep, 4s cyclus)
- Equalizer-balkjes bij "Nu Live" label (in goud ipv neon)
- Smooth scroll en focus-transities

## Pagina: Stempagina (index.html)

### Header
- Logo: "MUSIC REQUEST" in Playfair Display, goud kleur, letter-spacing 0.08em
- Subtitel: klein, uppercase, wijd gespatieerd, in warm grijs
- Vote counter: rosé kleur hartjes, pill-shaped border met rosé accent

### Song Cards
- Afgeronde kaarten (border-radius 14px)
- Achtergrond: `rgba(255,255,255,0.02)`, border `rgba(255,255,255,0.05)`
- Bij hover: achtergrond naar `rgba(201,168,76,0.06)`, border naar `rgba(201,168,76,0.15)`
- Muzieknoot-icoon (♫) in gedempte goud als visueel element links
- Titel in Playfair Display serif, artiest in sans-serif warm grijs
- Stemmenaantal in pill-badge, goud voor top-songs, grijs voor overige

### Zoek/filter
- Behoud bestaande zoekfunctionaliteit
- Input velden: transparante achtergrond, gouden border bij focus
- Genre tags: pill-shaped, subtiele gouden border

### Timer bar
- Achtergrond: donker semi-transparant met backdrop-blur
- Gouden border onderaan ipv neon magenta
- Countdown in champagne kleur, geen neon glow
- Bij urgent: rosé kleur, zachte pulse (opacity alleen, geen scale)

## Pagina: Setlist Big Screen (setlist.html)

### Header
- "SETLIST VANAVOND" in Playfair Display, goud
- Meta-rij (nog te spelen / totaal / gespeeld): nummers in goud serif, labels in grijs sans-serif

### Now Playing Hero
- Afgerond panel met gouden border `rgba(201,168,76,0.2)`
- Achtergrond: `rgba(201,168,76,0.06)`
- Shimmer-effect: zachte horizontale gradient sweep
- "Nu Live" label met equalizer-balkjes in goud
- Titel groot in Playfair Display, artiest in grijs sans-serif
- Stemmenaantal in rosé

### Setlist Items
- Grid layout (2 kolommen op groot scherm, 1 op mobiel)
- Positienummer in groot gedempte goud serif
- Gespeelde nummers: verlaagde opacity (0.35), doorgestreepte titel
- "Up Next" section divider: gouden tekst met fade-out lijn

### QR Code Overlay
- Donker panel met gouden border
- Label in goud, uppercase, wijd gespatieerd
- Subtiele box-shadow, geen neon glow

## Pagina: Admin (admin.html)

- Zelfde kleurenpalet toepassen
- Functioneel, geen visuele frills nodig
- Gouden accenten op knoppen en actieve states
- Rosé voor destructieve acties (verwijderen, reset)

## Celebration Overlay

- Confetti/sparkle effecten behouden maar in goud/champagne/rosé kleurenpalet
- Bericht in Playfair Display serif
- Achtergrond overlay donkerder en eleganter

## Responsive Design

- Bestaande breakpoints behouden (900px)
- Mobiel: enkele kolom, kleinere fonts, compactere spacing
- QR overlay kleiner op mobiel
- Touch-friendly tap targets (min 44px)

## Wat Niet Verandert

- Alle backend functionaliteit (server.js) blijft ongewijzigd
- SSE real-time updates blijven werken
- Stem-logica, admin authenticatie, timer — alles intact
- HTML structuur grotendeels behouden, alleen CSS en visuele elementen wijzigen
