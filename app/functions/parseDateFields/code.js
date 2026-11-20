function parseDateFields(value) {
    // Parses ISO 8601 timestamps (e.g. "2026-11-20T09:15:00.000Z") in keys named "at" or
    // ending in "_at", at any depth, into dates. Everything else is returned unchanged:
    // other keys, date-only values ("2026-11-20"), null, and strings that are not a valid timestamp.
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
    const isDateKey = (key) => key === 'at' || /_at$/.test(key);
    const walk = (v, depth) => {
        if (depth > 20 || v === null || typeof v !== 'object' || v instanceof Date) return v;
        if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
        const out = {};
        for (const key of Object.keys(v)) {
            const item = v[key];
            if (isDateKey(key) && typeof item === 'string' && ISO.test(item)) {
                const d = new Date(item);
                out[key] = isNaN(d.getTime()) ? item : d;
            } else {
                out[key] = walk(item, depth + 1);
            }
        }
        return out;
    };
    return walk(value, 0);
}
