-- CityLens 读城 数据库结构（SQLite / better-sqlite3）
-- 对应 PRD 5.2。所有 SQL 仅出现在仓储层。

CREATE TABLE IF NOT EXISTS cities (
    city_id       TEXT PRIMARY KEY,
    standard_name TEXT NOT NULL,
    province      TEXT NOT NULL,
    admin_level   TEXT NOT NULL,
    country_code  TEXT NOT NULL DEFAULT 'CN',
    pinyin        TEXT NOT NULL,
    english_name  TEXT NOT NULL,
    center_lng    REAL NOT NULL,
    center_lat    REAL NOT NULL,
    summary       TEXT,
    hot_rank      INTEGER
);

CREATE TABLE IF NOT EXISTS city_aliases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    alias_key     TEXT NOT NULL,
    display_alias TEXT,
    city_id       TEXT NOT NULL REFERENCES cities(city_id),
    match_type    TEXT NOT NULL,
    hint          TEXT,
    UNIQUE (alias_key, city_id, match_type)
);

CREATE INDEX IF NOT EXISTS idx_alias_key ON city_aliases(alias_key);
CREATE INDEX IF NOT EXISTS idx_alias_city ON city_aliases(city_id);

CREATE TABLE IF NOT EXISTS city_archives (
    city_id            TEXT PRIMARY KEY REFERENCES cities(city_id),
    status             TEXT NOT NULL,
    theme_palette_json TEXT NOT NULL,
    sources_json       TEXT NOT NULL,
    schema_version     TEXT NOT NULL DEFAULT '1.1',
    data_version       INTEGER NOT NULL DEFAULT 1,
    is_preset          INTEGER NOT NULL DEFAULT 0,
    generator_json     TEXT,
    generated_at       TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS city_modules (
    city_id           TEXT NOT NULL REFERENCES cities(city_id),
    module_name       TEXT NOT NULL,
    status            TEXT NOT NULL,
    data_json         TEXT,
    verification_json TEXT NOT NULL,
    generated_at      TEXT NOT NULL,
    PRIMARY KEY (city_id, module_name)
);

CREATE TABLE IF NOT EXISTS generation_jobs (
    job_id          TEXT PRIMARY KEY,
    city_id         TEXT NOT NULL REFERENCES cities(city_id),
    status          TEXT NOT NULL,
    force_flag      INTEGER NOT NULL DEFAULT 0,
    modules_json    TEXT NOT NULL,
    failed_json     TEXT,
    requester_hash  TEXT NOT NULL,
    llm_calls       INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    cooldown_until  TEXT,
    -- 客户端发起的生成尝试标识：断线恢复时在未收到 meta/jobId 前定位原任务。
    -- 旧库由 openDb 的幂等迁移补列（历史任务为 NULL，不伪造）。
    attempt_id      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_running_job ON generation_jobs(city_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_job_requester ON generation_jobs(requester_hash, started_at);
CREATE INDEX IF NOT EXISTS idx_job_city ON generation_jobs(city_id, started_at);
CREATE INDEX IF NOT EXISTS idx_job_attempt ON generation_jobs(city_id, attempt_id);

-- 逐次 LLM 调用日志：每日预算按「实际请求发生时间」所属北京日期记账。
-- 任务可能跨午夜运行，用 generation_jobs.started_at 汇总会把次日的调用算到前一天。
-- 迁移前的历史调用只有任务级 llm_calls 汇总、没有逐次时间戳，一律不补造记录。
CREATE TABLE IF NOT EXISTS llm_call_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id    TEXT NOT NULL,
    city_id   TEXT NOT NULL,
    called_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_call_log_at ON llm_call_log(called_at);

-- 档案发布与缓存查询辅助索引
CREATE INDEX IF NOT EXISTS idx_archive_status ON city_archives(status);

-- 运行时管理配置（当前用于大模型自定义配置）
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
