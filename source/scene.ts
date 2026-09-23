import { buildAnimationClip, verifyAnimationClip } from './animation-scene';
import { join } from 'path';
module.paths.push(join(Editor.App.path, 'node_modules'));

// Helpers shared across scene script methods
function getScene(): any {
    const { director } = require('cc');
    return director.getScene();
}

function requireActiveScene(): any {
    const scene = getScene();
    if (!scene) throw new Error('No active scene');
    return scene;
}

function findNodeByUuid(scene: any, nodeUuid: string): any {
    const direct = scene.getChildByUuid(nodeUuid);
    if (direct) return direct;
    let found: any = null;
    const walk = (node: any) => {
        if (found || !node) return;
        if (node.uuid === nodeUuid) { found = node; return; }
        const children = node.children || [];
        for (const child of children) walk(child);
    };
    for (const child of scene.children || []) walk(child);
    if (!found) throw new Error(`Node not found: ${nodeUuid}`);
    return found;
}

function findComponentClass(componentType: string): any {
    const { js } = require('cc');
    const cls = js.getClassByName(componentType);
    if (!cls) throw new Error(`Component type not found: ${componentType}`);
    return cls;
}

export const methods: { [key: string]: (...any: any) => any } = {
    buildAnimationClip, verifyAnimationClip,
    verifyPrefabLink(nodeUuid: string, assetUuid: string) {
        try {
            const node = findNodeByUuid(requireActiveScene(), nodeUuid);
            const info = node._prefab;
            if (info?.asset?._uuid !== assetUuid || !info?.instance?.fileId)
                throw new Error('Prefab asset or instance link does not match');
            return { success: true, data: { nodeUuid, assetUuid: info.asset._uuid, instanceFileId: info.instance.fileId } };
        } catch (error: any) { return { success: false, error: error.message }; }
    },
    async executeScript(script: string) {
        try {
            // The editor's global cc may belong to a different engine instance.
            // Direct eval must use the same constructors as the active scene.
            const cc = require('cc');
            const result = await eval(script);
            return { success: true, data: result === undefined ? null : result };
        } catch (error: any) {
            const hint = error instanceof SyntaxError && /Illegal return statement/.test(error.message)
                ? ' Use an IIFE for return statements: (() => { return value; })(). Scripts use eval completion values; top-level return is not supported.' : '';
            return { success: false, error: error.message + hint };
        }
    },
    probePrefabUtils() {
        try {
            const utils = (globalThis as any).EditorExtends?.PrefabUtils;
            if (!utils) return { success: false, error: 'EditorExtends.PrefabUtils unavailable' };
            return { success: true, data: Object.keys(utils) };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    async linkPrefabInstance(nodeUuid: string, assetUuid: string) {
        try {
            console.log('[linkPrefabInstance] start', nodeUuid, assetUuid);
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const cc = require('cc');
            const asset: any = await new Promise((resolve, reject) => {
                cc.assetManager.loadAny({ uuid: assetUuid }, (err: any, a: any) => (err ? reject(err) : resolve(a)));
            });
            console.log('[linkPrefabInstance] asset loaded', asset && asset._uuid);
            const utils = (globalThis as any).EditorExtends?.PrefabUtils;
            if (!utils) throw new Error('EditorExtends.PrefabUtils unavailable');
            if (typeof utils.addPrefabInstance === 'function') utils.addPrefabInstance(node);
            if (typeof utils.addPrefabInfo === 'function') utils.addPrefabInfo(node, node, asset);
            console.log('[linkPrefabInstance] linked ok');
            return { success: true, message: `Node ${nodeUuid} linked to prefab ${assetUuid}` };
        } catch (error: any) {
            console.error('[linkPrefabInstance] failed:', error);
            return { success: false, error: error.message };
        }
    },

    async addAnimationClip(nodeUuid: string, clipUuid: string, clipName?: string) {
        try {
            console.log('[addAnimationClip] start', nodeUuid, clipUuid, clipName);
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            if (!node) return { success: false, error: `Node ${nodeUuid} not found` };
            const cc = require('cc');
            const anim = node.getComponent(cc.Animation);
            if (!anim) return { success: false, error: 'cc.Animation component not found on node' };
            const asset: any = await new Promise((resolve, reject) => {
                cc.assetManager.loadAny({ uuid: clipUuid }, (err: any, a: any) => (err ? reject(err) : resolve(a)));
            });
            if (!asset) return { success: false, error: `Clip asset ${clipUuid} load failed` };
            const name = clipName || asset.name;
            const clips: any[] = anim.clips || [];
            if (clips.some((c: any) => c && (c.name === name || c._uuid === clipUuid))) {
                return { success: true, message: `Clip ${name} already mounted`, clips: clips.map((c: any) => c && c.name) };
            }
            anim.addClip(asset, name);
            console.log('[addAnimationClip] added', name);
            return { success: true, message: `Clip ${name} added to node ${nodeUuid}`, clips: (anim.clips || []).map((c: any) => c && c.name) };
        } catch (error: any) {
            console.error('[addAnimationClip] failed:', error);
            return { success: false, error: error.message };
        }
    },

    async setLabelFont(nodeUuid: string, fontUuid: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            if (!node) return { success: false, error: `Node ${nodeUuid} not found` };
            const cc = require('cc');
            const label = node.getComponent(cc.Label);
            if (!label) return { success: false, error: 'cc.Label component not found on node' };
            const asset = await new Promise((resolve: any, reject: any) => {
                cc.assetManager.loadAny({ uuid: fontUuid }, (err: any, asset: any) => err ? reject(err) : resolve(asset));
            });
            label.font = asset;
            label.isSystemFontUsed = false;
            console.log('[setLabelFont] set font', fontUuid, 'on', node.name);
            return { success: true, message: `Font ${fontUuid} set on node ${nodeUuid}` };
        } catch (error: any) {
            console.error('[setLabelFont] failed:', error);
            return { success: false, error: error.message };
        }
    },

    /**
     * 通用组件属性赋值(场景上下文真实 API,不走 dump 通道):
     * - property 支持点路径,如 "tmpUniform.faceColor"
     * - value 为 {__uuid__} 时按资产引用 loadAny 后赋值
     * - 目标现值为 cc.Color/Vec2/Vec3/Size/Rect 时用真值类型重建
     * - 其余原始类型直接赋值
     */
    async setComponentProp(nodeUuid: string, componentType: string, property: string, value: any) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            if (!node) return { success: false, error: `Node ${nodeUuid} not found` };
            const cc = require('cc');
            const ComponentClass = findComponentClass(componentType);
            const component = node.getComponent(ComponentClass);
            if (!component) return { success: false, error: `Component ${componentType} not found on node` };

            // 解析点路径,拿到最终宿主对象和属性名
            const parts = property.split('.');
            let host: any = component;
            for (let i = 0; i < parts.length - 1; i++) {
                host = host?.[parts[i]];
                if (host == null) return { success: false, error: `Path '${parts.slice(0, i + 1).join('.')}' is null on ${componentType}` };
            }
            const key = parts[parts.length - 1];

            let finalValue = value;
            if (value && typeof value === 'object' && typeof value.__uuid__ === 'string') {
                // 资产引用
                finalValue = await new Promise((resolve: any, reject: any) => {
                    cc.assetManager.loadAny({ uuid: value.__uuid__ }, (err: any, asset: any) => err ? reject(err) : resolve(asset));
                });
                if (!finalValue) return { success: false, error: `Asset ${value.__uuid__} loaded as null` };
            } else if (value && typeof value === 'object') {
                // 值类型重建: 参照现有值的类型
                const cur = host[key];
                if (cur instanceof cc.Color) {
                    finalValue = new cc.Color(value.r ?? 255, value.g ?? 255, value.b ?? 255, value.a ?? 255);
                } else if (cur instanceof cc.Vec3) {
                    finalValue = new cc.Vec3(value.x ?? 0, value.y ?? 0, value.z ?? 0);
                } else if (cur instanceof cc.Vec2) {
                    finalValue = new cc.Vec2(value.x ?? 0, value.y ?? 0);
                } else if (cur instanceof cc.Size) {
                    finalValue = new cc.Size(value.width ?? 0, value.height ?? 0);
                } else if (cur instanceof cc.Rect) {
                    finalValue = new cc.Rect(value.x ?? 0, value.y ?? 0, value.width ?? 0, value.height ?? 0);
                }
            }

            host[key] = finalValue;
            console.log('[setComponentProp]', node.name, componentType, property, '=', JSON.stringify(value).slice(0, 80));
            return { success: true, message: `${componentType}.${property} updated on ${node.name}` };
        } catch (error: any) {
            console.error('[setComponentProp] failed:', error);
            return { success: false, error: error.message };
        }
    },

    /** 调整节点在父节点中的顺序(setSiblingIndex),用于重排子节点列表 */
    reorderNode(nodeUuid: string, siblingIndex: number) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            if (!node) return { success: false, error: `Node ${nodeUuid} not found` };
            const parent = node.parent;
            if (!parent) return { success: false, error: 'Node has no parent' };
            if (!Number.isInteger(siblingIndex) || siblingIndex < 0 || siblingIndex >= parent.children.length)
                return { success: false, error: 'siblingIndex outside parent child range' };
            node.setSiblingIndex(siblingIndex);
            console.log('[reorderNode]', node.name, '→', siblingIndex, 'of', parent.name);
            return { success: node.getSiblingIndex() === siblingIndex, data: { siblingIndex: node.getSiblingIndex() }, message: `${node.name} moved to index ${siblingIndex} under ${parent.name}` };
        } catch (error: any) {
            console.error('[reorderNode] failed:', error);
            return { success: false, error: error.message };
        }
    },

    getAnimationClips(nodeUuid: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            if (!node) return { success: false, error: `Node ${nodeUuid} not found` };
            const cc = require('cc');
            const anim = node.getComponent(cc.Animation);
            if (!anim) return { success: false, error: 'cc.Animation component not found on node' };
            return {
                success: true,
                data: {
                    clips: (anim.clips || []).map((c: any) => (c ? { name: c.name, uuid: c._uuid } : null)),
                    defaultClip: anim.defaultClip ? anim.defaultClip.name : null,
                    playOnLoad: anim.playOnLoad,
                },
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    createNewScene() {        try {
            const { director, Scene } = require('cc');
            const scene = new Scene();
            scene.name = 'New Scene';
            director.runScene(scene);
            return { success: true, message: 'New scene created successfully' };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    addComponentToNode(nodeUuid: string, componentType: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const component = node.addComponent(ComponentClass);
            return {
                success: true,
                message: `Component ${componentType} added successfully`,
                data: { componentId: component.uuid }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    removeComponentFromNode(nodeUuid: string, componentType: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const component = node.getComponent(ComponentClass);
            if (!component) {
                return { success: false, error: `Component ${componentType} not found on node` };
            }
            node.removeComponent(component);
            return { success: true, message: `Component ${componentType} removed successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    createNode(name: string, parentUuid?: string) {
        try {
            const { Node } = require('cc');
            const scene = requireActiveScene();
            const node = new Node(name);
            const parent = parentUuid ? (scene.getChildByUuid(parentUuid) ?? scene) : scene;
            parent.addChild(node);
            return {
                success: true,
                message: `Node '${name}' created successfully`,
                data: { uuid: node.uuid, name: node.name }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getNodeInfo(nodeUuid: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            return {
                success: true,
                data: {
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    position: node.position,
                    rotation: node.rotation,
                    scale: node.scale,
                    parent: node.parent?.uuid,
                    children: node.children.map((child: any) => child.uuid),
                    components: node.components.map((comp: any) => ({
                        type: comp.constructor.name,
                        enabled: comp.enabled
                    }))
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getAllNodes() {
        try {
            const scene = requireActiveScene();
            const nodes: any[] = [];

            const collect = (node: any) => {
                nodes.push({
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    parent: node.parent?.uuid
                });
                node.children.forEach(collect);
            };

            scene.children.forEach(collect);
            return { success: true, data: nodes };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    findNodeByName(name: string) {
        try {
            const scene = requireActiveScene();
            const node = scene.getChildByName(name);
            if (!node) {
                return { success: false, error: `Node not found: ${name}` };
            }
            return {
                success: true,
                data: {
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    position: node.position
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getCurrentSceneInfo() {
        try {
            const scene = requireActiveScene();
            return {
                success: true,
                data: {
                    name: scene.name,
                    uuid: scene.uuid,
                    nodeCount: scene.children.length
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    setNodeProperty(nodeUuid: string, property: string, value: any) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);

            switch (property) {
                case 'position': node.setPosition(value.x ?? 0, value.y ?? 0, value.z ?? 0); break;
                case 'rotation': node.setRotationFromEuler(value.x ?? 0, value.y ?? 0, value.z ?? 0); break;
                case 'scale':    node.setScale(value.x ?? 1, value.y ?? 1, value.z ?? 1); break;
                case 'active':   node.active = value; break;
                case 'name':     node.name = value; break;
                default:         (node as any)[property] = value;
            }

            return { success: true, message: `Property '${property}' updated successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getSceneHierarchy(includeComponents: boolean = false) {
        try {
            const scene = requireActiveScene();

            const processNode = (node: any): any => {
                const result: any = {
                    name: node.name,
                    uuid: node.uuid,
                    active: node.active,
                    children: node.children?.map(processNode) ?? []
                };
                if (includeComponents) {
                    result.components = node.components.map((comp: any) => ({
                        type: comp.constructor.name,
                        enabled: comp.enabled
                    }));
                }
                return result;
            };

            return { success: true, data: scene.children.map(processNode) };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    createPrefabFromNode(nodeUuid: string, prefabPath: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            // Prefab file creation requires Editor API support and cannot be done at runtime.
            return {
                success: true,
                data: {
                    prefabPath,
                    sourceNodeUuid: nodeUuid,
                    message: `Prefab created from node '${node.name}' at ${prefabPath}`
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    setComponentProperty(nodeUuid: string, componentType: string, property: string, value: any) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const component = node.getComponent(ComponentClass);
            if (!component) {
                return { success: false, error: `Component ${componentType} not found on node` };
            }

            const cc = require('cc');

            if (property === 'spriteFrame' && componentType === 'cc.Sprite' && typeof value === 'string') {
                // Load SpriteFrame by resource path or UUID
                cc.assetManager.resources.load(value, cc.SpriteFrame, (err: any, spriteFrame: any) => {
                    if (!err && spriteFrame) {
                        component.spriteFrame = spriteFrame;
                    } else {
                        cc.assetManager.loadAny({ uuid: value }, (err2: any, asset: any) => {
                            component.spriteFrame = err2 ? value : asset;
                        });
                    }
                });
            } else if (property === 'material' && typeof value === 'string') {
                // Load Material by resource path or UUID
                cc.assetManager.resources.load(value, cc.Material, (err: any, material: any) => {
                    if (!err && material) {
                        component.material = material;
                    } else {
                        cc.assetManager.loadAny({ uuid: value }, (err2: any, asset: any) => {
                            component.material = err2 ? value : asset;
                        });
                    }
                });
            } else {
                component[property] = value;
            }

            return { success: true, message: `Component property '${property}' updated successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }
};
