# A1 — Reflection

*Written without AI, as the assignment requires. Headings are the assignment's own
questions; the answers are the author's, unedited.*

---

### 1 · What was hardest to determine about the generated notification design? What evidence helped you resolve it, or what remains uncertain?

The hardest part was understanding what "mute" really does. At first, I thought mute may stop notifications completely. But the as-built diagram shows routeMessage() decides inbox by message type, and mute only changes the alert. Also, unreadFor() always runs. So muted messages still count as unread, and mentions still enter the inbox. I am still not sure if the 100-notification limit and no SSE delivery guarantee are intentional.

### 2 · Which decision in your alternative design would most affect where the three changes land? What trade-off does that decision introduce?

The most important decision in my alternative design is moving the notification decision from write time to read time. The Inbox query creates notifications from the message log and subscription rules when users check them. Because of this, snooze lands in subscription rules, scheduled messages use visible-from, and digest uses a digest cursor. This makes data easier to keep consistent, but reading notifications becomes more complex and may need more processing.

### 3 · Which prediction differed most from what happened during the changes? What does that difference reveal about the generated system?

My most different prediction was about scheduled messages. I thought the new scheduler would be the hardest part. But the real problem was the existing 250 ms delayed save. The restart test showed that a scheduled message could be lost before saving, so I added synchronous flush(). This shows the notification boundary is quite good because deliver() and routeMessage() did not change. However, the generated system did not have a clear durability guarantee, and old code became risky when the new feature depended on it.
