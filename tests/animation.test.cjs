const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseClip, describeClip, mergeTracks, validateTracks } = require('../dist/animation-document');
const { AnimationTools } = require('../dist/tools/animation-tools');
const { waitForAnimationImport } = require('../dist/animation-import');

function clip(values = [true]) {
    return [{ __type__: 'cc.AnimationClip', _name: 'test', _duration: 1, sample: 60,
        _tracks: values.map((_, i) => ({ __id__: 1 + i * 2 })), _events: [{ frame: 0.5, func: 'testEvent', params: ['keep'] }] },
        ...values.flatMap((value, i) => [{ __type__: 'cc.animation.ObjectTrack', _binding: { path: { _paths: ['active'] } }, _channel: { _curve: { __id__: 2 + i * 2 } } }, { __type__: 'cc.ObjectCurve', _times: [0], _values: [value] }])];
}

test('replace/delete use original indexes, remap refs, preserve events and unknown data', () => {
    const original = clip([true, false]);
    original[0].custom = { __id__: 5 };
    original.push({ untouched: { __uuid__: 'keep-me' } });
    const before = JSON.stringify(original);
    const result = mergeTracks(original, clip([false]), [1], [0]);
    const description = describeClip(parseClip(JSON.stringify(result)));
    assert.equal(description.tracks.length, 1);
    assert.deepEqual(description.tracks[0].channels[0].values, [false]);
    assert.deepEqual(description.events, original[0]._events);
    assert.deepEqual(result[result[0].custom.__id__], original[5]);
    assert.equal(JSON.stringify(original), before);
});

test('repeated replacements do not accumulate unreachable serialized objects', () => {
    let result = clip();
    for (let i = 0; i < 50; i++) result = mergeTracks(result, clip([false]), [0]);
    assert.equal(result.length, 3);
});

test('conflicting, negative and out-of-bounds track indexes are rejected', () => {
    for (const [indexes, remove] of [[[0], [0]], [[2], []], [[-1], []], [[null], []], [[0], [1, 1]]]) {
        assert.throws(() => mergeTracks(clip(), clip(), indexes, remove));
    }
});

test('append and deletion-only edits preserve surviving tracks', () => {
    const added = mergeTracks(clip(), clip([false]), [undefined]);
    assert.equal(describeClip(added).tracks.length, 2);
    const deleted = mergeTracks(added, clip([]), [], [0]);
    assert.deepEqual(describeClip(deleted).tracks[0].channels[0].values, [false]);
});

test('invalid source graphs and dangling references are rejected', () => {
    assert.throws(() => parseClip('{}'));
    assert.throws(() => parseClip(JSON.stringify([{ __type__: 'cc.AnimationClip', _tracks: [{ __id__: 5 }] }])));
});

test('keys require sorted unique in-range times and typed finite values', () => {
    const valid = { kind: 'active', path: 'bg', keys: [{ time: 0, value: true }] };
    validateTracks([valid], 1);
    for (const keys of [[{ time: -1, value: true }], [{ time: 2, value: true }], [{ time: 0, value: 'true' }], [{ time: 0, value: true }, { time: 0, value: false }]]) {
        assert.throws(() => validateTracks([{ ...valid, keys }], 1));
    }
    assert.throws(() => validateTracks([{ ...valid, path: '../bg' }], 1));
    assert.throws(() => validateTracks([{ kind: 'position', path: '', keys: [{ time: 0, value: { x: 0, y: 0 } }] }], 1));
    validateTracks([{ kind: 'spriteFrame', path: 'bg', keys: [{ time: 0, value: { uuid: 'sprite-subasset' } }] }], 1);
});

test('existing project clips can be read and losslessly edited', async () => {
    const dir = path.resolve(__dirname, '../../../assets/bundle_game/anim');
    for (const file of (await fs.readdir(dir)).filter(f => f.endsWith('.anim'))) {
        const original = parseClip(await fs.readFile(path.join(dir, file), 'utf8'));
        const edited = mergeTracks(original, clip([]), [], []);
        assert.deepEqual(describeClip(edited), describeClip(original), file);
    }
});

test('asset workflow checks revisions, refuses overwrite and detects missing scene results', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-animation-test-'));
    const filename = path.join(dir, 'clip.anim');
    const tools = new AnimationTools();
    let exists = false, missingSceneResult = false;
    const calls = [];
    global.Editor = { Message: { request: async (group, method, ...args) => {
        calls.push(method);
        if (method === 'query-ready') return true;
        if (method === 'query-asset-info') return exists ? { uuid: 'stable-uuid' } : null;
        if (method === 'query-path') return filename;
        if (method === 'execute-scene-script') {
            if (missingSceneResult) return undefined;
            if (args[0].method === 'buildAnimationClip') return { success: true, data: { content: JSON.stringify(clip(args[0].args[0].tracks.map(t => t.keys[0].value))) } };
            const saved = parseClip(await fs.readFile(filename, 'utf8'));
            return { success: true, data: { trackCount: saved[0]._tracks.length, duration: saved[0]._duration } };
        }
        if (method === 'create-asset' || method === 'save-asset') { await fs.writeFile(filename, args[1]); exists = true; return { uuid: 'stable-uuid' }; }
        throw new Error('Unexpected method: ' + method);
    } } };
    try {
        const args = { url: 'db://assets/test.anim', name: 'test', duration: 1, tracks: [{ kind: 'active', path: '', keys: [{ time: 0, value: true }] }] };
        const created = await tools.execute('create_clip', args);
        assert.equal(created.success, true, created.error);
        assert.equal((await tools.execute('create_clip', args)).success, false);
        const read = await tools.execute('get_clip', { url: args.url });
        assert.equal(read.data.uuid, 'stable-uuid');
        const badRevision = await tools.execute('edit_tracks', { ...args, revision: 'old' });
        assert.match(badRevision.error, /Revision conflict/);
        const edited = await tools.execute('edit_tracks', { url: args.url, revision: read.data.revision, tracks: [{ ...args.tracks[0], index: 0, keys: [{ time: 0, value: false }] }] });
        assert.equal(edited.success, true, edited.error);
        assert.equal(edited.data.uuid, created.data.uuid);
        assert.deepEqual(edited.data.tracks[0].channels[0].values, [false]);
        missingSceneResult = true;
        const writes = calls.filter(c => c === 'save-asset').length;
        const noResult = await tools.execute('edit_tracks', { url: args.url, revision: edited.data.revision, tracks: [] });
        assert.equal(noResult.success, false);
        assert.equal(noResult.data.assetWritten, false);
        assert.equal(calls.filter(c => c === 'save-asset').length, writes);
    } finally { delete global.Editor; await fs.rm(dir, { recursive: true }); }
});

test('attachment preserves existing clip dumps and is idempotent with undo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-animation-test-'));
    const filename = path.join(dir, 'clip.anim');
    await fs.writeFile(filename, JSON.stringify(clip()));
    let attached = false;
    const calls = [];
    const existing = { type: 'cc.AnimationClip', value: { uuid: 'existing' }, readonly: false };
    global.Editor = { Message: { request: async (_, method, ...args) => {
        calls.push(method);
        if (method === 'query-asset-info') return { uuid: 'new-clip' };
        if (method === 'query-path') return filename;
        if (method === 'query-node') return { __comps__: [{ type: 'cc.Animation', value: { _clips: { type: 'cc.AnimationClip', isArray: true, value: [existing] } } }] };
        if (method === 'execute-scene-script') return { success: true, data: args[0].method === 'verifyAnimationClip' ? {} : { clips: [{ uuid: 'existing' }, ...(attached ? [{ uuid: 'new-clip' }] : [])], defaultClip: 'existing' } };
        if (method === 'begin-recording') return 'undo-id';
        if (method === 'end-recording') { assert.equal(args[0], 'undo-id'); return; }
        if (method === 'set-property') {
            assert.equal(args[0].path, '__comps__.0._clips');
            assert.deepEqual(args[0].dump.value, [existing, { type: 'cc.AnimationClip', value: { uuid: 'new-clip' } }]);
            attached = true; return;
        }
        throw new Error(method);
    } } };
    try {
        const tools = new AnimationTools();
        const args = { url: 'db://assets/test.anim', nodeUuid: 'node' };
        const first = await tools.execute('attach_clip', args);
        assert.equal(first.success, true, first.error);
        assert.equal(first.data.defaultClip, 'existing');
        assert.equal(first.data.requiresSave, true);
        assert.equal((await tools.execute('attach_clip', args)).data.alreadyAttached, true);
        assert.equal(calls.filter(c => c === 'set-property').length, 1);
        assert.deepEqual(calls.filter(c => c.endsWith('recording')), ['begin-recording', 'end-recording']);
    } finally { delete global.Editor; await fs.rm(dir, { recursive: true }); }
});

test('failed import verification reports that the asset has already been written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-animation-test-'));
    const filename = path.join(dir, 'clip.anim');
    let exists = false;
    global.Editor = { Message: { request: async (_, method, ...args) => {
        if (method === 'query-ready') return true;
        if (method === 'query-asset-info') return exists ? { uuid: 'test' } : null;
        if (method === 'query-path') return filename;
        if (method === 'create-asset') { await fs.writeFile(filename, args[1]); exists = true; return; }
        if (method === 'execute-scene-script') return args[0].method === 'buildAnimationClip'
            ? { success: true, data: { content: JSON.stringify(clip()) } }
            : { success: false, error: 'Importer failure' };
        throw new Error(method);
    } } };
    try {
        const result = await new AnimationTools().execute('create_clip', { url: 'db://assets/test.anim', name: 'test', duration: 1, tracks: [{ kind: 'active', path: '', keys: [{ time: 0, value: true }] }] });
        assert.equal(result.success, false);
        assert.equal(result.data.assetWritten, true);
        assert.match(result.error, /Importer failure/);
    } finally { delete global.Editor; await fs.rm(dir, { recursive: true }); }
});

test('transient CCON/import visibility failures are retried without a mutation', async () => {
    let calls = 0;
    const delays = [];
    const result = await waitForAnimationImport(async () => {
        if (++calls === 1) throw new Error('CCON Format error.');
        if (calls === 2) throw new Error('Imported animation verification failed');
        return { trackCount: 5 };
    }, async ms => { delays.push(ms); });
    assert.deepEqual(result, { value: { trackCount: 5 }, attempts: 3 });
    assert.deepEqual(delays, [100, 200]);
});

test('permanent failures and revision changes fail immediately; transient retries are bounded', async () => {
    for (const message of ['Missing SpriteFrame', 'Revision conflict during import verification', 'Scene method returned no result']) {
        let calls = 0;
        await assert.rejects(waitForAnimationImport(async () => { ++calls; throw new Error(message); }, async () => assert.fail('must not retry')), { message });
        assert.equal(calls, 1);
    }
    let calls = 0;
    await assert.rejects(waitForAnimationImport(async () => { ++calls; throw new Error('CCON Format error.'); }, async () => {}), /CCON/);
    assert.equal(calls, 6);
});
