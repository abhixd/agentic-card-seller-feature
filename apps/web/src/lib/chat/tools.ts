// ---------------------------------------------------------------
// Read-only tools available to the chat copilot
// ---------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition } from '@/types/chat'

// ---------------------------------------------------------------
// Tool definitions (schema exposed to the model)
// ---------------------------------------------------------------

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name:        'get_analysis',
      description: 'Retrieve the full analysis for a specific card by analysisId. Returns card details, market comps, fee breakdown, recommendation, and grading scenarios.',
      parameters:  {
        type:       'object',
        properties: {
          analysisId: {
            type:        'string',
            description: 'The UUID of the analysis to retrieve.',
          },
        },
        required: ['analysisId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'list_inventory',
      description: 'List all cards in the user\'s inventory with their status, estimated market value, and recommendation type. Use this to get an overview of what the user owns.',
      parameters:  {
        type:       'object',
        properties: {
          status: {
            type:        'string',
            enum:        ['owned', 'listed', 'sent_to_grading', 'sold'],
            description: 'Optional: filter by inventory status.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'find_sell_now_candidates',
      description: 'Find cards in the user\'s inventory that have a SELL_RAW recommendation. Returns items sorted by estimated market value descending.',
      parameters:  {
        type:       'object',
        properties: {},
        required:   [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'find_grading_candidates',
      description: 'Find cards in the user\'s inventory that have a GRADE recommendation — i.e., cards where submitting for grading has positive expected value.',
      parameters:  {
        type:       'object',
        properties: {},
        required:   [],
      },
    },
  },
]

// ---------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------

export async function runTool(
  toolName: string,
  argsJson: string,
  supabase: SupabaseClient,
  userId:   string,
): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(argsJson)
  } catch {
    return JSON.stringify({ error: 'Invalid tool arguments.' })
  }

  switch (toolName) {
    case 'get_analysis':
      return runGetAnalysis(supabase, userId, args)
    case 'list_inventory':
      return runListInventory(supabase, userId, args)
    case 'find_sell_now_candidates':
      return runFindSellNow(supabase, userId)
    case 'find_grading_candidates':
      return runFindGrading(supabase, userId)
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` })
  }
}

// ---------------------------------------------------------------
// get_analysis
// ---------------------------------------------------------------

async function runGetAnalysis(
  supabase:   SupabaseClient,
  userId:     string,
  args:       Record<string, unknown>,
): Promise<string> {
  const analysisId = args.analysisId
  if (typeof analysisId !== 'string') {
    return JSON.stringify({ error: 'analysisId is required.' })
  }

  // Fetch analysis — scoped to the user via inventory ownership
  const { data, error } = await supabase
    .from('card_analyses')
    .select(`
      analysis_id,
      catalog_id,
      recommendation_type,
      estimated_market_value,
      comp_range_low,
      comp_range_high,
      confidence_score,
      comp_count,
      days_of_data,
      net_proceeds,
      rationale_text,
      assumptions_json,
      created_at,
      card_catalog_items (
        card_name,
        franchise_or_brand,
        set_name,
        year,
        card_number,
        variant,
        category
      )
    `)
    .eq('analysis_id', analysisId)
    .single()

  if (error || !data) {
    return JSON.stringify({ error: 'Analysis not found.' })
  }

  const row = data as any
  const assumptions = row.assumptions_json ?? {}

  return JSON.stringify({
    analysis_id:           row.analysis_id,
    card:                  row.card_catalog_items,
    recommendation:        row.recommendation_type,
    rationale:             row.rationale_text,
    estimated_market_value: row.estimated_market_value,
    comp_range:            { low: row.comp_range_low, high: row.comp_range_high },
    confidence_score:      row.confidence_score,
    comp_count:            row.comp_count,
    days_of_data:          row.days_of_data,
    net_proceeds:          row.net_proceeds,
    platform:              assumptions.platform,
    shipping_cost:         assumptions.shippingCost,
    acquisition_cost:      assumptions.acquisitionCost,
    condition_score:       assumptions.conditionScore ?? null,
    created_at:            row.created_at,
  })
}

// ---------------------------------------------------------------
// list_inventory
// ---------------------------------------------------------------

async function runListInventory(
  supabase: SupabaseClient,
  userId:   string,
  args:     Record<string, unknown>,
): Promise<string> {
  let query = supabase
    .from('inventory_items')
    .select(`
      item_id,
      status,
      acquisition_cost,
      created_at,
      card_catalog_items ( card_name, franchise_or_brand, set_name, year, card_number, variant, category ),
      card_analyses ( recommendation_type, estimated_market_value )
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (typeof args.status === 'string') {
    query = query.eq('status', args.status) as typeof query
  }

  const { data, error } = await query

  if (error) {
    return JSON.stringify({ error: error.message })
  }

  const items = (data ?? []).map((row: any) => ({
    item_id:               row.item_id,
    status:                row.status,
    acquisition_cost:      row.acquisition_cost,
    card_name:             row.card_catalog_items?.card_name,
    franchise_or_brand:    row.card_catalog_items?.franchise_or_brand,
    set_name:              row.card_catalog_items?.set_name,
    year:                  row.card_catalog_items?.year,
    recommendation:        row.card_analyses?.recommendation_type ?? null,
    estimated_market_value: row.card_analyses?.estimated_market_value ?? null,
  }))

  return JSON.stringify({ count: items.length, items })
}

// ---------------------------------------------------------------
// find_sell_now_candidates
// ---------------------------------------------------------------

async function runFindSellNow(
  supabase: SupabaseClient,
  userId:   string,
): Promise<string> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select(`
      item_id,
      status,
      acquisition_cost,
      card_catalog_items ( card_name, franchise_or_brand, set_name, year ),
      card_analyses ( recommendation_type, estimated_market_value, net_proceeds )
    `)
    .eq('user_id', userId)
    .eq('status', 'owned')
    .order('created_at', { ascending: false })

  if (error) {
    return JSON.stringify({ error: error.message })
  }

  const candidates = (data ?? [])
    .filter((row: any) => row.card_analyses?.recommendation_type === 'SELL_RAW')
    .sort((a: any, b: any) =>
      (b.card_analyses?.estimated_market_value ?? 0) -
      (a.card_analyses?.estimated_market_value ?? 0)
    )
    .map((row: any) => ({
      item_id:               row.item_id,
      card_name:             row.card_catalog_items?.card_name,
      franchise_or_brand:    row.card_catalog_items?.franchise_or_brand,
      set_name:              row.card_catalog_items?.set_name,
      year:                  row.card_catalog_items?.year,
      estimated_market_value: row.card_analyses?.estimated_market_value ?? null,
      net_proceeds:          row.card_analyses?.net_proceeds ?? null,
      acquisition_cost:      row.acquisition_cost,
    }))

  return JSON.stringify({ count: candidates.length, candidates })
}

// ---------------------------------------------------------------
// find_grading_candidates
// ---------------------------------------------------------------

async function runFindGrading(
  supabase: SupabaseClient,
  userId:   string,
): Promise<string> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select(`
      item_id,
      status,
      acquisition_cost,
      card_catalog_items ( card_name, franchise_or_brand, set_name, year ),
      card_analyses ( recommendation_type, estimated_market_value, rationale_text )
    `)
    .eq('user_id', userId)
    .eq('status', 'owned')
    .order('created_at', { ascending: false })

  if (error) {
    return JSON.stringify({ error: error.message })
  }

  const candidates = (data ?? [])
    .filter((row: any) => row.card_analyses?.recommendation_type === 'GRADE')
    .sort((a: any, b: any) =>
      (b.card_analyses?.estimated_market_value ?? 0) -
      (a.card_analyses?.estimated_market_value ?? 0)
    )
    .map((row: any) => ({
      item_id:               row.item_id,
      card_name:             row.card_catalog_items?.card_name,
      franchise_or_brand:    row.card_catalog_items?.franchise_or_brand,
      set_name:              row.card_catalog_items?.set_name,
      year:                  row.card_catalog_items?.year,
      estimated_market_value: row.card_analyses?.estimated_market_value ?? null,
      rationale:             row.card_analyses?.rationale_text ?? null,
      acquisition_cost:      row.acquisition_cost,
    }))

  return JSON.stringify({ count: candidates.length, candidates })
}
