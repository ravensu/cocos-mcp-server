import { validateTracks } from './animation-document';

/** Uses the installed engine and editor serializer rather than hard-coded curve layouts. */
export async function buildAnimationClip(args: any): Promise<any> {
    try {
        validateTracks(args.tracks, args.duration);
        const cc = require('cc');
        const serialize = (globalThis as any).EditorExtends?.serialize;
        if (typeof serialize !== 'function') throw new Error('EditorExtends.serialize unavailable');
        const clip = new cc.AnimationClip();
        clip.name = args.name;
        clip.duration = args.duration;
        clip.sample = args.sample || 60;
        for (const spec of args.tracks) {
            const object = ['spriteFrame', 'active'].includes(spec.kind);
            const vector = ['position', 'scale'].includes(spec.kind);
            const track = object ? new cc.animation.ObjectTrack() : vector ? new cc.animation.VectorTrack() : new cc.animation.RealTrack();
            let path = new cc.animation.TrackPath();
            if (spec.path) path = path.toHierarchy(spec.path);
            if (spec.kind === 'spriteFrame') path = path.toComponent('cc.Sprite');
            if (spec.kind === 'number') path = path.toComponent(spec.component);
            track.path = path.toProperty(spec.kind === 'number' ? spec.property : spec.kind);
            if (vector) track.componentsCount = 3;
            if (object) {
                const keys = [];
                for (const key of spec.keys) {
                    let value = key.value;
                    if (spec.kind === 'spriteFrame' && value !== null) {
                        value = await new Promise((resolve, reject) => cc.assetManager.loadAny({ uuid: value.uuid }, (err: any, asset: any) => err ? reject(err) : resolve(asset)));
                        if (!(value instanceof cc.SpriteFrame)) throw new Error('Referenced asset is not a SpriteFrame');
                    }
                    keys.push([key.time, value]);
                }
                track.channels()[0].curve.assignSorted(keys);
            } else {
                const channels = track.channels();
                for (let i = 0; i < (vector ? 3 : 1); ++i) {
                    channels[i].curve.assignSorted(spec.keys.map((key: any) => [key.time, { value: vector ? key.value[['x', 'y', 'z'][i]] : key.value, interpolationMode: cc.RealInterpolationMode.LINEAR }]));
                }
            }
            clip.addTrack(track);
        }
        const serialized = serialize(clip, { dontStripDefault: true, compressUuid: false, useCCON: false });
        return { success: true, data: { content: typeof serialized === 'string' ? serialized : JSON.stringify(serialized) } };
    } catch (error: any) { return { success: false, error: error.message }; }
}

export async function verifyAnimationClip(uuid: string, nodeUuid?: string): Promise<any> {
    try {
        const cc = require('cc');
        const clip: any = await new Promise((resolve, reject) => cc.assetManager.loadAny({ uuid }, { reloadAsset: true }, (err: any, asset: any) => err ? reject(err) : resolve(asset)));
        if (!(clip instanceof cc.AnimationClip)) throw new Error('Imported asset is not an AnimationClip');
        if (nodeUuid) {
            const find = (node: any): any => {
                if (!node) return null;
                if (node.uuid === nodeUuid) return node;
                for (const child of node.children || []) { const result = find(child); if (result) return result; }
                return null;
            };
            const root = find(cc.director.getScene());
            if (!root) throw new Error('Animation root node not found');
            for (let i = 0; i < clip.tracksCount; i++) {
                const path = clip.getTrack(i).path;
                let target = root;
                for (let p = 0; p < path.length; p++) {
                    if (target === null || target === undefined) throw new Error(`Track ${i}: missing target at path segment ${p}`);
                    if (path.isHierarchyAt(p)) target = target.getChildByPath?.(path.parseHierarchyAt(p));
                    else if (path.isComponentAt(p)) target = target.getComponent?.(path.parseComponentAt(p));
                    else if (path.isPropertyAt(p)) {
                        const key = path.parsePropertyAt(p);
                        if (!(key in Object(target))) throw new Error(`Track ${i}: property ${key} not found`);
                        target = target[key];
                    } else if (path.isElementAt(p)) target = target[path.parseElementAt(p)];
                    else throw new Error(`Track ${i}: custom binding cannot be verified`);
                    // A final property may legitimately hold null (e.g. spriteFrame).
                    if (p === path.length - 1 && (path.isHierarchyAt(p) || path.isComponentAt(p)) && !target) throw new Error(`Track ${i}: target not found`);
                }
            }
        }
        return { success: true, data: { name: clip.name, duration: clip.duration, trackCount: clip.tracksCount } };
    } catch (error: any) { return { success: false, error: error.message }; }
}
