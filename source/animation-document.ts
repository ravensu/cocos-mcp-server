/** Lossless edits to Creator 3.8 serialized object graphs. Untouched objects stay intact. */
export function parseClip(content: string): any[] {
    const objects = JSON.parse(content);
    if (!Array.isArray(objects) || objects[0]?.__type__ !== 'cc.AnimationClip' || !Array.isArray(objects[0]._tracks)) {
        throw new Error('Expected a Creator 3.8 AnimationClip object graph');
    }
    const visit = (v: any): void => {
        if (!v || typeof v !== 'object') return;
        if ('__id__' in v && (!Number.isInteger(v.__id__) || v.__id__ < 0 || v.__id__ >= objects.length)) throw new Error('Invalid object reference');
        Object.values(v).forEach(visit);
    };
    visit(objects);
    return objects;
}

export function describeClip(objects: any[]): any {
    const resolve = (v: any): any => v && typeof v === 'object' && '__id__' in v ? objects[v.__id__] : v;
    const clip = objects[0];
    return {
        name: clip._name, duration: clip._duration, sample: clip.sample,
        tracks: clip._tracks.map((ref: any, index: number) => {
            const track = resolve(ref);
            const binding = resolve(track._binding);
            const path = resolve(binding?.path);
            const channels = track._channels || (track._channel ? [track._channel] : []);
            return { index, type: track.__type__, path: (path?._paths || []).map(resolve),
                channels: channels.map((c: any) => {
                    const curve = resolve(resolve(c)._curve);
                    return { times: curve?._times, values: curve?._values };
                }) };
        }),
        events: clip._events || []
    };
}

/** Track indexes refer to the original document, so batch deletion cannot shift targets. */
export function validateTrackIndexes(count: number, replacements: (number | undefined)[], remove: number[] = []): void {
    if (!Array.isArray(remove)) throw new Error('remove must be an array');
    const seen = new Set<number>();
    for (const index of [...remove, ...replacements.filter((x): x is number => x !== undefined)]) {
        if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) throw new Error('Invalid or duplicate track index');
        seen.add(index);
    }
}

export function mergeTracks(original: any[], generated: any[], replacements: (number | undefined)[], remove: number[] = []): any[] {
    const result = JSON.parse(JSON.stringify(original));
    const refs = result[0]._tracks;
    validateTrackIndexes(refs.length, replacements, remove);
    if (generated[0]._tracks.length !== replacements.length) throw new Error('Generated track count mismatch');
    const offset = result.length;
    const remap = (v: any): any => {
        if (Array.isArray(v)) return v.map(remap);
        if (!v || typeof v !== 'object') return v;
        if ('__id__' in v) return { ...v, __id__: v.__id__ + offset };
        return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, remap(value)]));
    };
    result.push(...generated.map(remap));
    generated[0]._tracks.forEach((ref: any, i: number) => {
        const mapped = remap(ref);
        if (replacements[i] === undefined) refs.push(mapped);
        else refs[replacements[i]!] = mapped;
    });
    result[0]._tracks = refs.filter((_: any, i: number) => !remove.includes(i));
    // Compact unreachable objects, preserving all references from the clip, including events and extras.
    const reachable = new Map<number, number>();
    const compact: any[] = [];
    const copy = (v: any): any => {
        if (Array.isArray(v)) return v.map(copy);
        if (!v || typeof v !== 'object') return v;
        if ('__id__' in v) return { ...v, __id__: copyObject(v.__id__) };
        return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, copy(value)]));
    };
    const copyObject = (id: number): number => {
        if (reachable.has(id)) return reachable.get(id)!;
        const next = compact.length;
        reachable.set(id, next);
        compact.push(null);
        compact[next] = copy(result[id]);
        return next;
    };
    copyObject(0);
    return compact;
}

export function validateTracks(tracks: any[], duration: number): void {
    if (!Array.isArray(tracks) || !Number.isFinite(duration) || duration <= 0) throw new Error('Positive duration and tracks array required');
    for (const t of tracks) {
        if (!['spriteFrame', 'active', 'position', 'scale', 'number'].includes(t.kind)) throw new Error('Unsupported track kind');
        if (typeof t.path !== 'string' || (t.path !== '' && t.path.split('/').some((s: string) => !s || s === '..' || s === '.')) || t.path.includes('\\')) throw new Error('Invalid relative node path');
        if (t.kind === 'number' && (typeof t.component !== 'string' || !t.component || typeof t.property !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(t.property))) throw new Error('Number track requires component and direct property');
        if (!Array.isArray(t.keys) || t.keys.length === 0) throw new Error('At least one key required');
        let previous = -1;
        for (const key of t.keys) {
            if (!Number.isFinite(key.time) || key.time < 0 || key.time > duration || key.time <= previous) throw new Error('Key times must be sorted, unique and within duration');
            previous = key.time;
            if (t.kind === 'active' && typeof key.value !== 'boolean') throw new Error('active requires boolean values');
            if (t.kind === 'spriteFrame' && key.value !== null && (typeof key.value !== 'object' || typeof key.value.uuid !== 'string' || !key.value.uuid)) throw new Error('spriteFrame requires {uuid} or null');
            if (t.kind === 'number' && !Number.isFinite(key.value)) throw new Error('number requires finite values');
            if (['position', 'scale'].includes(t.kind) && (!key.value || !['x', 'y', 'z'].every(k => Number.isFinite(key.value[k])))) throw new Error('Vector requires finite x/y/z');
        }
    }
}
