# Prompt / config versions

Every change to `config/` bumps `experiment.prompt_version`. `/admin` shows each version separately.

| Version | Date | What changed |
|---|---|---|
| free_chat_v2.2 | 8 Oct 2026 | Opening offers "shaadi, naukri, paisa ya pyaar" (not "sehat": a health question gets the scripted doctor line, with no kundli and no reading) |
| free_chat_v2.1 | 8 Oct 2026 | Slower replies (~1.3×): read_delay 600→1000 ms, typing_max 1800→2400 ms. Prompt unchanged from v2.0 |
| free_chat_v2.0 | 8 Oct 2026 | Prompt from 377 real chats: answer "kab" with a chart window (not a dodge), hook on THEIR topic, reply in the user's language, greetings get a greeting, opening offers topics, no copied example lines, stricter "zaroor …" guard |
| free_chat_v1.9 | 7 Oct 2026 | Offer copy: top strip "🎉 You've unlocked a special offer!", card "🎁 A special offer awaits you 👀" (was 100% cashback). Reply instructions moved into config.yaml |
| free_chat_v1.8 | 30 Sep 2026 | Missing data never blocks a chat: no name → "Namaste ji" and "aap"; no gender/place → left out; no birth time → rashi/dasha only stated when certain (no kundli card if the rashi isn't). Prompt tightened (facts block built from known data only). One question per reply. Team form removed |
| free_chat_v1.7 | 29 Sep 2026 | The first answer always answers the question (answer + the planet behind it). Wrong-dasha guard catches every phrasing, and mahadasha vs antardasha mix-ups |
| free_chat_v1.6 | 29 Sep 2026 | CTA "Talk to astrologer": the tap connects to a different, human astrologer, so no "continue" |
| free_chat_v1.5 | 29 Sep 2026 | Curiosity hook on the card: "…sabse zaroori baat abhi batani baaki hai 👀" |
| free_chat_v1.4 | 29 Sep 2026 | Simpler card hook; "Talk to our top astrologers" under the CTA; countdown ring and confetti |
| free_chat_v1.3 | 29 Sep 2026 | Vandana's feedback: cohorts (lapsed / low / zero balance), CTA link by wallet balance, attribution on every tap, no "pandit ji" on the CTA |
| free_chat_v1.2 | 25 Sep 2026 | Answer the first question, then small personal insights, one open thread at the end. Omkar speaks after 25 s of silence. 2–3 bubbles. No "pandit ji" inside the chat |
| free_chat_v1.1 | 25 Sep 2026 | "Seen, not solved" (rejected: nothing got answered) |
| free_chat_v1.0 | 24 Sep 2026 | First internal team test |
