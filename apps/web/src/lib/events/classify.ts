import type { EventType, EventConfidence } from './types'

const CARD_SHOW_RE     = /card\s?show|card\s?expo|card\s?convention|card\s?fair|card\s?swap|card\s?meet/i
const TCG_RE           = /pokemon\s?(tcg|tournament)|yugioh|yu-gi-oh|magic.{0,5}gathering|trading\s?card\s?game|tcg\s?tournament|card\s?tournament|flesh\s?and\s?blood|one\s?piece\s?card|digimon\s?card/i
const COLLECTOR_RE     = /sports\s?card|baseball\s?card|football\s?card|basketball\s?card|graded\s?card|psa\s?show|beckett|memorabilia/i
const CONVENTION_RE    = /comic.?con|anime.?expo|gaming\s?convention|hobby.?show|collectible.?convention|collector.?show|pop\s?culture/i
const POKEMON_GENERAL  = /\bpokemon\b|\bpikachu\b|\bcharizard\b/i

export function classifyEvent(
  title: string,
  description?: string | null,
  category?: string | null,
): { event_type: EventType; source_confidence: EventConfidence; tags: string[] } {
  const full = [title, description, category].filter(Boolean).join(' ')
  const tags: string[] = []

  if (POKEMON_GENERAL.test(full)) tags.push('pokemon')
  if (TCG_RE.test(full))          tags.push('tcg')
  if (COLLECTOR_RE.test(full))    tags.push('sports-cards')
  if (CARD_SHOW_RE.test(full))    tags.push('card-show')

  if (CARD_SHOW_RE.test(title)) {
    return { event_type: 'card_show', source_confidence: 'high', tags }
  }
  if (TCG_RE.test(title)) {
    return { event_type: 'tcg_tournament', source_confidence: 'high', tags }
  }
  if (COLLECTOR_RE.test(title)) {
    return { event_type: 'collector_event', source_confidence: 'high', tags }
  }
  if (CARD_SHOW_RE.test(full) || TCG_RE.test(full)) {
    return { event_type: 'card_show', source_confidence: 'medium', tags }
  }
  if (COLLECTOR_RE.test(full)) {
    return { event_type: 'collector_event', source_confidence: 'medium', tags }
  }
  if (CONVENTION_RE.test(full)) {
    return { event_type: 'convention', source_confidence: 'medium', tags }
  }
  if (POKEMON_GENERAL.test(full)) {
    return { event_type: 'tcg_tournament', source_confidence: 'low', tags }
  }
  return { event_type: 'general', source_confidence: 'low', tags }
}
