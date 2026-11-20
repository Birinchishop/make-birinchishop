it('parses *_at and at keys at any depth', () => {
    const r = parseDateFields({
        id: 1,
        created_at: '2026-11-20T09:15:00.000Z',
        api_key: { expires_at: '2026-12-01T00:00:00Z' },
        paths: [{ ordered_at: '2026-11-19T10:00:00.000Z', steps: [{ at: '2026-11-18T08:30:00+05:00', role: 'first' }] }],
    });
    assert.ok(r.created_at instanceof Date);
    assert.strictEqual(r.created_at.toISOString(), '2026-11-20T09:15:00.000Z');
    assert.ok(r.api_key.expires_at instanceof Date);
    assert.ok(r.paths[0].ordered_at instanceof Date);
    assert.strictEqual(r.paths[0].steps[0].at.toISOString(), '2026-11-18T03:30:00.000Z');
    assert.strictEqual(r.paths[0].steps[0].role, 'first');
    assert.strictEqual(r.id, 1);
});

it('leaves other values unchanged', () => {
    const r = parseDateFields({ expires_at: null, delivery_date: '2026-11-22', updated_at: 'soon', note: '2026-11-20T09:15:00Z', created_at: '' });
    assert.strictEqual(r.expires_at, null);
    assert.strictEqual(r.delivery_date, '2026-11-22');
    assert.strictEqual(r.updated_at, 'soon');
    assert.strictEqual(r.note, '2026-11-20T09:15:00Z');
    assert.strictEqual(r.created_at, '');
});

it('accepts empty and non-object input', () => {
    assert.strictEqual(parseDateFields(null), null);
    assert.strictEqual(parseDateFields(undefined), undefined);
    assert.strictEqual(parseDateFields('x'), 'x');
    assert.deepStrictEqual(parseDateFields([]), []);
});
