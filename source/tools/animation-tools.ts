import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { ToolDefinition, ToolExecutor, ToolResponse } from '../types';
import { describeClip, mergeTracks, parseClip, validateTracks, validateTrackIndexes } from '../animation-document';
import { waitForAnimationImport } from '../animation-import';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const trackSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        index: { type: 'integer', minimum: 0, description: 'Original track index to replace; omit to append' },
        kind: { type: 'string', enum: ['spriteFrame', 'active', 'position', 'scale', 'number'] },
        path: { type: 'string', description: 'Node path relative to the Animation component; empty for its own node' },
        component: { type: 'string', description: 'Component class for number tracks' },
        property: { type: 'string', description: 'Direct component property for number tracks' },
        keys: { type: 'array', minItems: 1, items: { type: 'object', properties: {
            time: { type: 'number', minimum: 0 }, value: { description: 'boolean, number, {x,y,z}, or SpriteFrame {uuid}/null according to kind' }
        }, required: ['time', 'value'], additionalProperties: false } }
    }, required: ['kind', 'path', 'keys']
};

export class AnimationTools implements ToolExecutor {
    private busy = new Set<string>();
    getTools(): ToolDefinition[] {
        const url = { type: 'string', description: 'Standalone .anim asset URL under db://assets/' };
        return [
            { name: 'create_clip', description: 'Create a Creator animation with typed tracks using the engine serializer. Never overwrites an existing asset.', inputSchema: {
                type: 'object', properties: { url, name: { type: 'string' }, duration: { type: 'number', exclusiveMinimum: 0 }, sample: { type: 'integer', minimum: 1 }, tracks: { type: 'array', items: trackSchema } }, required: ['url', 'name', 'duration', 'tracks'], additionalProperties: false } },
            { name: 'get_clip', description: 'Read animation tracks, keyframes, events and revision for safe editing.', inputSchema: { type: 'object', properties: { url }, required: ['url'], additionalProperties: false } },
            { name: 'edit_tracks', description: 'Batch append/replace/delete tracks. Indexes refer to the original clip. Preserves untouched tracks/events; requires revision from get_clip.', inputSchema: {
                type: 'object', properties: { url, revision: { type: 'string' }, tracks: { type: 'array', items: trackSchema }, remove: { type: 'array', items: { type: 'integer', minimum: 0 }, uniqueItems: true } }, required: ['url', 'revision', 'tracks'], additionalProperties: false } },
            { name: 'attach_clip', description: 'Attach a clip to an existing cc.Animation through editor properties with undo. Marks scene/prefab dirty; save separately.', inputSchema: { type: 'object', properties: { url, nodeUuid: { type: 'string' } }, required: ['url', 'nodeUuid'], additionalProperties: false } }
        ];
    }

    private async scene(method: string, args: any[]): Promise<any> {
        const result = await Editor.Message.request('scene', 'execute-scene-script', { name: 'cocos-mcp-server', method, args });
        if (!result?.success) throw new Error(result?.error || `Scene method ${method} returned no result`);
        return result.data;
    }

    private async read(url: string): Promise<{ content: string; objects: any[]; uuid: string }> {
        const info = await Editor.Message.request('asset-db', 'query-asset-info', url);
        if (!info?.uuid) throw new Error('Animation asset does not exist');
        const path = await Editor.Message.request('asset-db', 'query-path', url);
        if (!path) throw new Error('Asset has no source file');
        const content = await readFile(path, 'utf8');
        return { content, objects: parseClip(content), uuid: info.uuid };
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        const url = args?.url;
        let locked = false;
        let written = false;
        try {
            if (typeof url !== 'string' || !/^db:\/\/assets\/.+\.anim$/.test(url) || url.includes('\\') || url.split('/').some(s => s === '..' || s === '.') || /[?#%]/.test(url)) throw new Error('Expected a db://assets/ relative .anim URL');
            if (toolName === 'get_clip') {
                const current = await this.read(url);
                return { success: true, data: { uuid: current.uuid, revision: hash(current.content), ...describeClip(current.objects) } };
            }
            if (!['create_clip', 'edit_tracks', 'attach_clip'].includes(toolName)) throw new Error('Unknown animation tool');
            if (this.busy.has(url)) throw new Error('Animation asset is already being edited');
            this.busy.add(url); locked = true;
            if (toolName === 'attach_clip') {
                const current = await this.read(url);
                await this.scene('verifyAnimationClip', [current.uuid, args.nodeUuid]);
                const node: any = await Editor.Message.request('scene', 'query-node', args.nodeUuid);
                const index = node?.__comps__?.findIndex((c: any) => (c.__type__ || c.cid || c.type) === 'cc.Animation');
                if (index === undefined || index < 0) throw new Error('Node must have cc.Animation; use component_add_component first');
                const state = await this.scene('getAnimationClips', [args.nodeUuid]);
                if (state.clips.some((c: any) => c?.uuid === current.uuid)) return { success: true, data: { alreadyAttached: true, uuid: current.uuid } };
                const clipDump = node.__comps__[index].value?._clips;
                if (!clipDump?.isArray || !Array.isArray(clipDump.value)) throw new Error('Editor did not provide an editable Animation clips array');
                const dump = JSON.parse(JSON.stringify(clipDump));
                dump.value.push({ type: 'cc.AnimationClip', value: { uuid: current.uuid } });
                const undo = await Editor.Message.request('scene', 'begin-recording', args.nodeUuid);
                try {
                    await Editor.Message.request('scene', 'set-property', { uuid: args.nodeUuid, path: `__comps__.${index}._clips`, dump });
                } finally { await Editor.Message.request('scene', 'end-recording', undo); }
                const actual = await this.scene('getAnimationClips', [args.nodeUuid]);
                if (!actual.clips.some((c: any) => c?.uuid === current.uuid)) throw new Error('Attachment verification failed');
                return { success: true, data: { ...actual, requiresSave: true } };
            }
            const current = toolName === 'edit_tracks' ? await this.read(url) : null;
            if (current && hash(current.content) !== args.revision) throw new Error('Revision conflict; read the clip again');
            if (!current && await Editor.Message.request('asset-db', 'query-asset-info', url)) throw new Error('Asset already exists');
            const duration = current ? current.objects[0]._duration : args.duration;
            validateTracks(args.tracks, duration);
            if (!current && (typeof args.name !== 'string' || !args.name || (args.sample !== undefined && (!Number.isInteger(args.sample) || args.sample < 1)) || args.tracks.some((t: any) => t.index !== undefined))) throw new Error('Invalid clip name, sample or new track index');
            // Validate batch indexes before asking the scene process to load referenced assets.
            if (current) validateTrackIndexes(current.objects[0]._tracks.length, args.tracks.map((t: any) => t.index), args.remove || []);
            const built = await this.scene('buildAnimationClip', [{ name: current ? current.objects[0]._name : args.name, duration, sample: current ? current.objects[0].sample : args.sample, tracks: args.tracks }]);
            const generated = parseClip(built.content);
            const objects = current ? mergeTracks(current.objects, generated, args.tracks.map((t: any) => t.index), args.remove || []) : generated;
            const content = JSON.stringify(objects, null, 2);
            if (current && hash((await this.read(url)).content) !== args.revision) throw new Error('Revision conflict during build');
            if (current) await Editor.Message.request('asset-db', 'save-asset', url, content);
            else await Editor.Message.request('asset-db', 'create-asset', url, content, { overwrite: false, rename: false });
            written = true;
            const saved = await this.read(url);
            if (saved.content !== content || (current && current.uuid !== saved.uuid)) throw new Error('Saved content or UUID verification failed');
            const verification = await waitForAnimationImport(async () => {
                const latest = await this.read(url);
                if (latest.uuid !== saved.uuid || latest.content !== content) throw new Error('Revision conflict during import verification');
                if (!await Editor.Message.request('asset-db', 'query-ready')) throw new Error('Animation import is not ready');
                const loaded = await this.scene('verifyAnimationClip', [saved.uuid]);
                if (loaded.trackCount !== objects[0]._tracks.length || loaded.duration !== duration) throw new Error('Imported animation verification failed');
                return loaded;
            });
            return { success: true, data: { uuid: saved.uuid, revision: hash(saved.content), ...describeClip(saved.objects), imported: true, verificationAttempts: verification.attempts } };
        } catch (error: any) {
            return { success: false, error: error.message, data: { assetWritten: written, url } };
        } finally { if (locked) this.busy.delete(url); }
    }
}
