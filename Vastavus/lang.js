/**
 * lang.js — all user-visible strings AND card data for the Bee Matching exercise.
 *
 * Structure:
 *   TRANSLATIONS['et'] — Estonian strings + card data
 *   TRANSLATIONS['en'] — English strings + card data
 *
 * Each language object uses the same keys so they are interchangeable.
 * Values are either plain strings or, where dynamic content is needed,
 * functions that accept parameters and return a string.
 *
 * The `data` key holds the exercise content for each language:
 *   data[i] = [ anchorLabel, textCardContent, imageURL ]
 *   Image URLs are identical across languages (same files, different text only).
 *   The index position of each entry must match across languages — index 0 in 'et'
 *   and index 0 in 'en' must describe the same subject, because dataIndex values
 *   stored on card objects are used for correctness checking regardless of language.
 *
 * Usage in main script via the T() helper:
 *   T('btnCheck')          → plain string lookup
 *   T('popupErrBody', 3)   → calls the function with argument 3
 *   T('data')              → returns the full data array for the current language
 */

const TRANSLATIONS = {

  /* ════════════════════════════════════════════════
     ESTONIAN
  ════════════════════════════════════════════════ */
  et: {

    // ── Exercise card data ─────────────────────────
    // Each entry: [ anchorLabel, textCardContent, imagePath ]
    // imagePath is relative to index.html and shared across languages.
    data : [
    [
        "õun",
        "Kukkus Newtonile pähe",
        "./pildid/apple.jpg"
    ],
    [
        "banaan",
        "Ahvi lemmik",
        "./pildid/banana.png"
    ],
    [
        "porgand",
        "Pikergune juurvili, mida jänesed armastavad.",
        "./pildid/carrot.jpg"
    ],
    [
        "kartul",
        "Pr. keelest maa õun. Vajadusel saab kastide mõõtmeid ja arvu, lisaks teksti suurust muuta.",
        "./pildid/potato.jpg"
    ],
    [
        "tomat",
        "saadaval mitmes variandis: ploom-, kirss-, kobar-, kollane, must, roheline, lilla ...",
        "./pildid/tomato.jpg"
    ],
    [
        "Arbuus",
        "Krõmpsuga vesi. Ka kõik teised disainielemendid on muudetavad: andke ainult märku ning saan uuendada.",
        "./pildid/watermelon.jpg"
    ],
    [
        "Kirss",
        "Käib tordi peale.",
        "./pildid/cherries.jpg"
    ]
  ],

    // ── UI strings ────────────────────────────────
    title:          'Kes on kes?',

    // Info button has two states: panel closed / panel open
    btnInfo:        'Juhend',
    btnInfoClose:   'Sulge',
    btnCheck:       'Kontrolli',
    btnReset:       'Uuesti',

    // Language-switch button shows the language you will switch TO
    btnLang:        'EN',

    // Info panel body — HTML markup is allowed
    infoPanelHtml: `Liiguta iga kaart õige mesilase alla.
      Igale mesilasele vastab <strong>kaks kaarti</strong> — üks pilt ja üks kirjeldus.
      Otsi <strong style="color:var(--amber)">kollast varju</strong> kaardi liigutamisel:
      siis on ta valmis haakuma. Paikapandud kaardi liigutamiseks lihtsalt tõmba ta eemale.
      Kui <strong>kõik kaardid</strong> on paigas, vajuta <strong>kontrolli</strong>.`,

    // Shown when the device is held in portrait orientation
    portraitMsg:    'Kasutatav ainult külili (landscape)',

    // Popup: not all cards placed yet
    popupWarnTitle: 'Kaardid puuduvad',
    popupWarnBody:  'Aseta enne kontrollimist kõik kaardid tulpadesse.',

    // Popup: every card is in the correct column
    popupOkTitle:   'Tubli!',
    popupOkBody:    'Kõik kaardid on õiges kohas! Vajuta "Uuesti", et järgmine külaline saaks mängida.',

    // Popup: some cards wrong — receives wrong-card count as argument
    popupErrTitle:  'Proovi veel!',
    popupErrBody:   (n) => `${n} kaart${n === 1 ? ' on' : 'i on'} vales kohas. Vaata üle ja proovi uuesti.`,

    // Popup dismiss button
    popupClose:     'Sulge',

    // Shown inside an image card when the file cannot be loaded
    imgMissing:     '🖼 Pilt puudub',
  },

  /* ════════════════════════════════════════════════
     ENGLISH
  ════════════════════════════════════════════════ */
  en: {

    // ── Exercise card data ─────────────────────────
    // Entries must stay in the SAME ORDER as the Estonian data above.
    // Only anchorLabel and textCardContent differ; imagePath is identical.
    data : [
    [
        "apple",
        "Fell on Newton's head",
        "./pildid/apple.jpg"
    ],
    [
        "banana",
        "Ape's favorite",
        "./pildid/banana.png"
    ],
    [
        "carrot",
        "long and orange. Rabbits love it.",
        "./pildid/carrot.jpg"
    ],
    [
        "potato",
        "brown and earthy. The name comes from the Spanish word for 'earth apple' — patata.",
        "./pildid/potato.jpg"
    ],
    [
        "tomato",
        "multiple varieties available: plum, cherry, grape, yellow, black, green, purple ...",
        "./pildid/tomato.jpg"
    ],
    [
        "watermelon",
        "Crunchy refreshment. All design elements are also adjustable: just let me know and I can update them.",
        "./pildid/watermelon.jpg"
    ],
    [
        "Cherries",
        "Cake topping.",
        "./pildid/cherries.jpg"
    ]
  ],

    // ── UI strings ────────────────────────────────
    title:          'Who is who?',

    btnInfo:        'Help',
    btnInfoClose:   'Close',
    btnCheck:       'Check',
    btnReset:       'Reset',
    btnLang:        'ET',

    infoPanelHtml: `Drag each card under the correct heading.
      Each heading has <strong>two matching cards</strong> — one image and one description.
      Look for the <strong style="color:var(--amber)">amber shadow</strong> when dragging:
      it means the card is ready to snap into place. To move a placed card, drag it away
      until it releases. When <strong>all cards</strong> are placed, press <strong>check</strong>.`,

    portraitMsg:    'Please rotate your device to landscape',

    popupWarnTitle: 'Cards missing',
    popupWarnBody:  'Place all cards in columns before checking.',

    popupOkTitle:   'Well done!',
    popupOkBody:    'All cards are in the right place! Press "Reset" so the next visitor can play.',

    popupErrTitle:  'Try again!',
    popupErrBody:   (n) => `${n} card${n === 1 ? ' is' : 's are'} in the wrong place. Review and try again.`,

    popupClose:     'Close',

    imgMissing:     '🖼 Image missing',
  },
};