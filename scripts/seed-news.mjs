import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const envFile = readFileSync(join(__dir, '..', '.env.local'), 'utf8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
  if (m) process.env[m[1]] = m[2]
}

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const NOW = new Date('2026-04-02T08:00:00Z')
const ago = (h) => new Date(NOW.getTime() - h * 3600000).toISOString()

const ARTICLES = [
  {
    title: "Charizard ex Alt-Art Finds Floor After Destined Rivals Hype Cools",
    body: `The Charizard ex alternate-art from Destined Rivals has finally stabilized around $148 after its opening-weekend peak of $220, a 33% correction in under three weeks. This settles it roughly 12% above the Obsidian Flames Charizard ex alt-art at comparable age — a premium the market appears to accept given the newer artwork and higher pull rate speculation.

For sellers, the critical signal is inventory velocity: PSA 10 copies are moving in under 48 hours at $310–$340, suggesting graded demand has not cooled even as raw prices compressed. Buyers who pulled alt-arts during release week and graded immediately are sitting on 40–50% margin after grading fees.

The broader Charizard premium is holding. Base Set 1st Edition PSA 10 touched $10,500 in a February eBay auction — its highest confirmed sale since the 2021 pandemic peak. Structural support remains: Charizard is the only Pokemon to have its PSA 10 value hold above $8k across three separate market cycles.

Watch: if Destined Rivals gets a booster bundle reprint (Stellar Crown Mew ex dropped 40% within a week of its bundle announcement), the raw alt-art floor could soften further. Graded copies are relatively insulated.`,
    tags: ['charizard', 'price-spike', 'new-set', 'grading'],
    published_at: ago(2),
  },
  {
    title: "Mega Evolution Rumor Adds 35% to Physical Mega Charizard X — How to Position",
    body: `An unverified leak suggesting a dedicated "Mega Evolution ex" set for Q3 2026 has caused Mega Charizard EX (XY — Flashfire, FA) to spike from $28 to $38 in the past three weeks, a 35.7% gain on pure speculation. Mega Gardevoir EX and Mega Gyarados EX are up 15–22% on the same narrative.

The TCG Pocket "Mega Shine" booster announcement is almost certainly fueling this — Pocket and physical TCG share a speculative feedback loop. When Pocket spotlights a mechanic, physical card hunters follow.

Historical analog: before the Sword & Shield era confirmed returning Mewtwo V, Mewtwo EX cards from Base Set era ran up 60% on speculation over six weeks, then gave back 40% when the confirmed product was revealed to be a new-art print rather than legacy reprint.

Positioning logic: if you own Mega Charizard X (especially 1st-ed or full-art variants), the risk/reward of holding through Q2 is asymmetric. Confirmation of the set likely adds another 20–40%. Denial or silence drops the card 25–30% quickly. Consider selling 50% of position here to lock gains while maintaining upside exposure.`,
    tags: ['price-spike', 'market-analysis', 'upcoming-set', 'charizard'],
    published_at: ago(5),
  },
  {
    title: "Prismatic Evolutions Umbreon ex Full-Art: Value Floor or Continued Climb?",
    body: `Three months post-release, Umbreon ex Full-Art from Prismatic Evolutions has held above $170 — a remarkable floor for a card from a widely-distributed set. For comparison, Sylveon ex FA from the same set sits at $62, and Espeon ex FA at $45. The Umbreon premium (3.7x Espeon) reflects both collector demand for dark-type aesthetics and the "grail card" effect that Umbreon commands uniquely among Eevee-lutions.

The PSA 10 population is currently 1,847 — relatively low given print run size, implying either excellent card quality (fewer rejects) or that bulk graders haven't processed their pulls yet. As PSA 10 pop climbs toward 3,000–4,000 (expected by Q3 2026 at current submission rates), expect 15–20% softening on raw graded copies.

Raw NM copies are holding $172–$178. The risk: Prismatic Evolutions has already shown up in booster bundles twice. A third bundle inclusion could compress raw prices 25–30% quickly. Smart money is watching GameStop/Target bundle announcements closely.

For inventory purposes: Umbreon ex FA is the single highest-turn card in most sellers' inventory. Avg hold time before sale: 4.2 days (TCGPlayer data proxy). That velocity justifies carrying higher stock than comparable-price singles.`,
    tags: ['eevee', 'price-spike', 'market-analysis', 'grading'],
    published_at: ago(9),
  },
  {
    title: "PSA Economy Tier Is Now Worth It Again — The Math Has Changed",
    body: `PSA's Economy tier (officially 90-day SLA) has been running 12–16 business days for Pokemon cards submitted in Q1 2026 — well under the quoted turnaround. Combined with the current $25/card fee, this makes Economy tier profitable for cards above $85 NM raw price, assuming a conservative PSA 10 rate of 60%.

The breakeven math: $25 grading fee + $4 shipping allocation + $2 handling = $31 all-in cost. A card worth $100 raw NM becomes ~$165 as PSA 10 (1.65x multiplier, industry average for modern holos). That's $65 value-add on $31 cost = 110% ROI in under 3 weeks. Unprecedented since 2021.

Bulk tier (25+ cards, $18/card) pushes the breakeven down to cards above $55 raw — which opens up submitting Destined Rivals holo rares and Secret Rares that would previously have been borderline.

The risk: PSA turnarounds are dynamic. A backlog surge (new set release weeks are historically 2x normal volume) can push Economy back to 45+ days. Submit now before Battle Partners (June 2026) floods the queue.

Cards currently hitting best ROI on Economy: Umbreon ex FA (PE), Charizard ex (DR), Iron Valiant ex (PAF), and Miraidon ex (SVI special illustration).`,
    tags: ['grading', 'market-analysis', 'arbitrage'],
    published_at: ago(14),
  },
  {
    title: "Japanese Exclusive Premium Compresses — Best Arbitrage Window in 18 Months",
    body: `The premium for Japanese-exclusive Pokemon TCG cards versus US equivalents has narrowed to its tightest spread since early 2024. Japanese Shiny Treasures ex Charizard (Shiny) is trading at 28% above US equivalents — down from the 50–65% premium seen through mid-2025.

The compression has three causes: yen strengthening (USD/JPY moved from 158 to 147 over 6 months), increased Japanese import availability via Amazon JP direct shipping, and a general cooling in "JP exclusive" hype as US localization caught up with most key products.

The arbitrage window: if USD/JPY reverses back toward 155–158 (plausible if Fed holds rates), the USD cost of Japanese exclusives drops another 5–8%, compressing premiums further. The opposite scenario — dollar weakens — rebuilds the premium and rewards current holders.

Higher-risk, higher-reward: Pokémon Card Game Classic (Japanese exclusive, three-set reprints of vintage era) is still at 45% premium to comparable US singles. The set has no announced US release. If an English Classic set is confirmed (persistent rumor), that premium collapses. If no announcement by Q4 2026, the premium likely expands as supply dwindles.

Current recommendation: neutral on broad Japanese premium exposure; specific opportunities in Shiny Treasures ex holos where premium has overcorrected.`,
    tags: ['japanese', 'arbitrage', 'market-analysis'],
    published_at: ago(20),
  },
  {
    title: "Battle Partners (Jun 2026) Set Overview: What to Target at Launch",
    body: `The confirmed card list for Battle Partners — releasing June 13, 2026 in Japan, July 11 internationally — features returning Blastoise ex and Venusaur ex lines as its headline pulls. Pre-release prices for known cards are already diverging in interesting ways.

Blastoise ex Special Illustration Rare is pre-ordering at $95–$110 — a significant premium for pre-release, reflecting the character's enduring collector appeal and the relative scarcity of high-quality Blastoise art in modern era. Venusaur ex SIR is tracking $55–$65, consistent with its historically lower demand versus Blastoise and Charizard.

The contrarian play: Pikachu ex (confirmed in the set) has a full-art variant that pre-ordering at just $35. Post-release full-arts of Pikachu from comparable sets have averaged $55–$70 at 60-day post-release. The pre-release price implies the market expects weak art or low pull rate — either assumption could be wrong.

Standard strategy for launch week: order 3–6 booster boxes through your usual distributor (allocation permitting), prioritize pulling Blastoise SIRs for immediate PSA submission, and watch eBay sold listings daily for the first two weeks to track price velocity.

Key risk: Blastoise ex was hinted in Obsidian Flames-era promotional material and never appeared — if Battle Partners underdelivers on art quality, pre-release premiums can collapse 50% within days of official reveals.`,
    tags: ['new-set', 'upcoming-set', 'market-analysis'],
    published_at: ago(27),
  },
]

async function run() {
  let inserted = 0
  for (const a of ARTICLES) {
    const slug = a.title.slice(0, 50).toLowerCase()
      .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') +
      '-' + a.published_at.slice(0, 10)

    const { error } = await supa.from('pokemon_news').upsert({
      slug,
      title:       a.title,
      summary:     a.body.slice(0, 280),
      body:        a.body,
      source_url:  null,
      source_name: 'NEXUS Intelligence',
      tags:        a.tags,
      published_at: a.published_at,
    }, { onConflict: 'slug' })

    if (error) console.error(`✗ ${a.title.slice(0, 60)}: ${error.message}`)
    else { console.log(`✓ ${a.title.slice(0, 70)}`); inserted++ }
  }
  console.log(`\nInserted ${inserted}/${ARTICLES.length} articles`)
}

run().catch(err => { console.error(err); process.exit(1) })
