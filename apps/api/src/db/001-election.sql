CREATE TABLE editions (
 id text PRIMARY KEY, country text NOT NULL, year integer NOT NULL, round integer NOT NULL,
 election_date date NOT NULL, active_publication_id uuid,
 UNIQUE(country,year,round)
);
CREATE TABLE publications (
 id uuid PRIMARY KEY, edition_id text NOT NULL REFERENCES editions(id),
 status text NOT NULL CHECK(status IN ('preparing','published')),
 scope text NOT NULL CHECK(scope IN ('pilot','national')),
 parser_version text NOT NULL, coverage jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
 UNIQUE(edition_id,id)
);
ALTER TABLE editions ADD FOREIGN KEY(id,active_publication_id) REFERENCES publications(edition_id,id);
CREATE TABLE source_documents (
 id uuid PRIMARY KEY, publication_id uuid NOT NULL REFERENCES publications(id),
 url text NOT NULL, sha256 text NOT NULL CHECK(length(sha256)=64), archive_path text NOT NULL,
 kind text NOT NULL, generated_at text, collected_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb NOT NULL DEFAULT '{}', UNIQUE(publication_id,url), UNIQUE(publication_id,id)
);
CREATE TABLE import_runs (
 publication_id uuid PRIMARY KEY REFERENCES publications(id), state text NOT NULL,
 expected_documents integer NOT NULL DEFAULT 0, completed_documents integer NOT NULL DEFAULT 0,
 options jsonb NOT NULL, error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE areas (
 publication_id uuid NOT NULL REFERENCES publications(id), id text NOT NULL,
 level text NOT NULL CHECK(level IN ('country','region','state','municipality','zone','section')),
 name text NOT NULL, uf text, municipality_code text, zone_code text, section_code text,
 feature_id text, parent_id text, principal_area_id text,
 PRIMARY KEY(publication_id,id),
 FOREIGN KEY(publication_id,parent_id) REFERENCES areas(publication_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(publication_id,principal_area_id) REFERENCES areas(publication_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX areas_navigation ON areas(publication_id,level,uf,municipality_code,zone_code,id);
CREATE TABLE contests (
 publication_id uuid NOT NULL REFERENCES publications(id), id text NOT NULL,
 election_id text NOT NULL, office_code text NOT NULL, office_name text NOT NULL,
 scope_area_id text NOT NULL, seats integer, vote_type text NOT NULL,
 PRIMARY KEY(publication_id,id),
 FOREIGN KEY(publication_id,scope_area_id) REFERENCES areas(publication_id,id)
);
CREATE TABLE parties (
 publication_id uuid NOT NULL REFERENCES publications(id), number text NOT NULL,
 abbreviation text NOT NULL, name text NOT NULL, PRIMARY KEY(publication_id,number)
);
CREATE TABLE candidacies (
 publication_id uuid NOT NULL, contest_id text NOT NULL, id text NOT NULL,
 official_id text NOT NULL, number text NOT NULL, name text NOT NULL, display_name text NOT NULL,
 party_number text, status text, vote_destination text, elected boolean,
 coalition jsonb, federation jsonb, running_mates jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(publication_id,contest_id,id), UNIQUE(publication_id,contest_id,official_id),
 FOREIGN KEY(publication_id,contest_id) REFERENCES contests(publication_id,id),
 FOREIGN KEY(publication_id,party_number) REFERENCES parties(publication_id,number)
);
CREATE INDEX candidacies_lookup ON candidacies(publication_id,contest_id,number);
CREATE TABLE area_results (
 publication_id uuid NOT NULL, contest_id text NOT NULL, area_id text NOT NULL,
 source_id uuid NOT NULL, source_kind text NOT NULL CHECK(source_kind IN ('EA20','BU')),
 status text NOT NULL, complete boolean NOT NULL,
 eligible bigint CHECK(eligible >= 0), turnout bigint CHECK(turnout >= 0), abstentions bigint CHECK(abstentions >= 0),
 total_votes bigint CHECK(total_votes >= 0), valid_votes bigint CHECK(valid_votes >= 0),
 nominal_votes bigint CHECK(nominal_votes >= 0), legend_votes bigint CHECK(legend_votes >= 0),
 blank_votes bigint CHECK(blank_votes >= 0), null_votes bigint CHECK(null_votes >= 0),
 sections_total bigint, sections_counted bigint, metadata jsonb NOT NULL,
 PRIMARY KEY(publication_id,contest_id,area_id),
 FOREIGN KEY(publication_id,contest_id) REFERENCES contests(publication_id,id),
 FOREIGN KEY(publication_id,area_id) REFERENCES areas(publication_id,id),
 FOREIGN KEY(publication_id,source_id) REFERENCES source_documents(publication_id,id)
);
CREATE TABLE candidate_results (
 publication_id uuid NOT NULL, contest_id text NOT NULL, area_id text NOT NULL,
 candidate_id text NOT NULL, votes bigint NOT NULL CHECK(votes >= 0),
 official_percentage numeric, vote_destination text,
 PRIMARY KEY(publication_id,contest_id,area_id,candidate_id),
 FOREIGN KEY(publication_id,contest_id,area_id) REFERENCES area_results(publication_id,contest_id,area_id) ON DELETE CASCADE,
 FOREIGN KEY(publication_id,contest_id,candidate_id) REFERENCES candidacies(publication_id,contest_id,id)
);
CREATE INDEX candidate_distribution ON candidate_results(publication_id,contest_id,candidate_id,area_id);
CREATE TABLE party_results (
 publication_id uuid NOT NULL, contest_id text NOT NULL, area_id text NOT NULL, party_number text NOT NULL,
 nominal_votes bigint, valid_nominal_votes bigint, legend_votes bigint, valid_legend_votes bigint,
 PRIMARY KEY(publication_id,contest_id,area_id,party_number),
 FOREIGN KEY(publication_id,contest_id,area_id) REFERENCES area_results(publication_id,contest_id,area_id) ON DELETE CASCADE,
 FOREIGN KEY(publication_id,party_number) REFERENCES parties(publication_id,number)
);
-- BU votables retain printed votes even when no candidacy can be verified, without inventing a candidate.
CREATE TABLE votable_results (
 publication_id uuid NOT NULL, contest_id text NOT NULL, area_id text NOT NULL,
 number text NOT NULL, vote_type text NOT NULL, party_number text, votes bigint NOT NULL CHECK(votes >= 0),
 PRIMARY KEY(publication_id,contest_id,area_id,number,vote_type),
 FOREIGN KEY(publication_id,contest_id,area_id) REFERENCES area_results(publication_id,contest_id,area_id) ON DELETE CASCADE
);
CREATE TABLE import_tasks (
 publication_id uuid NOT NULL REFERENCES publications(id), url text NOT NULL, kind text NOT NULL,
 context jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','official_absence')),
 PRIMARY KEY(publication_id,url)
);
