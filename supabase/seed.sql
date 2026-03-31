-- ---------------------------------------------------------------
-- Seed: sample card catalog items
-- Covers sports (NBA, NFL, MLB), TCG (Pokemon, MTG), and other
-- ---------------------------------------------------------------

-- Clear existing seed data (idempotent)
delete from public.card_catalog_items
where metadata_json->>'seed' = 'true';

insert into public.card_catalog_items
  (category, franchise_or_brand, set_name, year, card_name, card_number, variant, metadata_json)
values

-- ---------------------------------------------------------------
-- Pokemon TCG
-- ---------------------------------------------------------------
('tcg', 'Pokemon', 'Base Set', 1999, 'Charizard', '4/102', null,
  '{"seed":"true","rarity":"Holo Rare","hp":120}'),

('tcg', 'Pokemon', 'Base Set', 1999, 'Blastoise', '2/102', null,
  '{"seed":"true","rarity":"Holo Rare","hp":100}'),

('tcg', 'Pokemon', 'Base Set', 1999, 'Venusaur', '15/102', null,
  '{"seed":"true","rarity":"Holo Rare","hp":100}'),

('tcg', 'Pokemon', 'Base Set', 1999, 'Pikachu', '58/102', null,
  '{"seed":"true","rarity":"Common","hp":40}'),

('tcg', 'Pokemon', 'Base Set 2', 2000, 'Charizard', '4/130', null,
  '{"seed":"true","rarity":"Holo Rare","hp":120}'),

('tcg', 'Pokemon', 'Jungle', 1999, 'Scyther', '26/64', null,
  '{"seed":"true","rarity":"Holo Rare","hp":70}'),

('tcg', 'Pokemon', 'Neo Genesis', 2000, 'Lugia', '9/111', null,
  '{"seed":"true","rarity":"Holo Rare","hp":90}'),

('tcg', 'Pokemon', 'Expedition', 2002, 'Charizard', 'H6/H32', 'Holo',
  '{"seed":"true","rarity":"Holo Rare","hp":120}'),

('tcg', 'Pokemon', 'Scarlet & Violet', 2023, 'Charizard ex', '125/198', null,
  '{"seed":"true","rarity":"Double Rare","hp":330}'),

('tcg', 'Pokemon', 'Scarlet & Violet', 2023, 'Pikachu ex', '79/198', null,
  '{"seed":"true","rarity":"Rare","hp":120}'),

-- ---------------------------------------------------------------
-- NBA Sports Cards
-- ---------------------------------------------------------------
('sports', 'NBA', 'Fleer', 1986, 'Michael Jordan', '57', 'Rookie',
  '{"seed":"true","team":"Chicago Bulls","position":"SG"}'),

('sports', 'NBA', 'Topps Chrome', 2003, 'LeBron James', '111', 'Rookie',
  '{"seed":"true","team":"Cleveland Cavaliers","position":"SF"}'),

('sports', 'NBA', 'Fleer', 1969, 'Lew Alcindor', '25', 'Rookie',
  '{"seed":"true","team":"Milwaukee Bucks","position":"C","note":"Later known as Kareem Abdul-Jabbar"}'),

('sports', 'NBA', 'Bowman Chrome', 2012, 'Anthony Davis', '1', 'Rookie',
  '{"seed":"true","team":"New Orleans Hornets","position":"PF"}'),

('sports', 'NBA', 'Panini Prizm', 2018, 'Luka Doncic', '280', 'Rookie Silver Prizm',
  '{"seed":"true","team":"Dallas Mavericks","position":"PG"}'),

-- ---------------------------------------------------------------
-- NFL Sports Cards
-- ---------------------------------------------------------------
('sports', 'NFL', 'Topps', 1958, 'Jim Brown', '62', 'Rookie',
  '{"seed":"true","team":"Cleveland Browns","position":"RB"}'),

('sports', 'NFL', 'Donruss', 2000, 'Tom Brady', '230', 'Rookie',
  '{"seed":"true","team":"New England Patriots","position":"QB"}'),

('sports', 'NFL', 'Panini Prizm', 2017, 'Patrick Mahomes', '269', 'Rookie',
  '{"seed":"true","team":"Kansas City Chiefs","position":"QB"}'),

('sports', 'NFL', 'Panini Prizm', 2021, 'Trevor Lawrence', '339', 'Rookie',
  '{"seed":"true","team":"Jacksonville Jaguars","position":"QB"}'),

-- ---------------------------------------------------------------
-- MLB Sports Cards
-- ---------------------------------------------------------------
('sports', 'MLB', 'Topps', 1952, 'Mickey Mantle', '311', null,
  '{"seed":"true","team":"New York Yankees","position":"CF"}'),

('sports', 'MLB', 'Topps', 1989, 'Ken Griffey Jr.', '41T', 'Rookie',
  '{"seed":"true","team":"Seattle Mariners","position":"CF"}'),

('sports', 'MLB', 'Bowman Chrome', 2011, 'Mike Trout', 'BP5', 'Prospect',
  '{"seed":"true","team":"Los Angeles Angels","position":"CF"}'),

('sports', 'MLB', 'Topps', 1955, 'Roberto Clemente', '164', 'Rookie',
  '{"seed":"true","team":"Pittsburgh Pirates","position":"RF"}'),

-- ---------------------------------------------------------------
-- Magic: The Gathering
-- ---------------------------------------------------------------
('tcg', 'MTG', 'Alpha', 1993, 'Black Lotus', null, null,
  '{"seed":"true","rarity":"Rare","type":"Artifact","mana_cost":"0"}'),

('tcg', 'MTG', 'Alpha', 1993, 'Ancestral Recall', null, null,
  '{"seed":"true","rarity":"Uncommon","type":"Instant","mana_cost":"U"}'),

('tcg', 'MTG', 'Beta', 1993, 'Mox Sapphire', null, null,
  '{"seed":"true","rarity":"Rare","type":"Artifact","mana_cost":"0"}'),

('tcg', 'MTG', 'Unlimited', 1993, 'Time Walk', null, null,
  '{"seed":"true","rarity":"Rare","type":"Sorcery","mana_cost":"1U"}'),

-- ---------------------------------------------------------------
-- One Piece TCG
-- ---------------------------------------------------------------
('tcg', 'One Piece TCG', 'Romance Dawn', 2022, 'Monkey D. Luffy', 'OP01-001', 'Leader',
  '{"seed":"true","rarity":"Leader","color":"Red"}'),

('tcg', 'One Piece TCG', 'Romance Dawn', 2022, 'Roronoa Zoro', 'OP01-118', 'Secret Rare',
  '{"seed":"true","rarity":"Secret Rare","color":"Green"}');
