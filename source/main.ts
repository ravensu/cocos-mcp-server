import { MCPServer } from './mcp-server';
import { readSettings, saveSettings } from './settings';
import { MCPServerSettings } from './types';
import { ToolManager } from './tools/tool-manager';

let mcpServer: MCPServer | null = null;
let toolManager: ToolManager;

function mergeSettings(partial: Partial<MCPServerSettings>): MCPServerSettings {
    return { ...readSettings(), ...partial };
}

async function applyServerSettings(settings: MCPServerSettings, restart: boolean): Promise<void> {
    const wasRunning = mcpServer?.getStatus().running ?? false;
    if (mcpServer) {
        mcpServer.stop();
    }
    mcpServer = new MCPServer(settings);
    mcpServer.updateEnabledTools(toolManager.getEnabledTools());
    if (restart && wasRunning) {
        await mcpServer.start();
    }
}

export const methods: { [key: string]: (...any: any) => any } = {
    openPanel() {
        Editor.Panel.open('cocos-mcp-server');
    },

    async startServer() {
        if (!mcpServer) {
            console.warn('[MCP] mcpServer is not initialized');
            return;
        }
        mcpServer.updateEnabledTools(toolManager.getEnabledTools());
        await mcpServer.start();
    },

    async stopServer() {
        if (!mcpServer) {
            console.warn('[MCP] mcpServer is not initialized');
            return;
        }
        mcpServer.stop();
    },

    getServerStatus() {
        const status = mcpServer ? mcpServer.getStatus() : { running: false, port: 0, clients: 0 };
        const settings = mcpServer ? mcpServer.getSettings() : readSettings();
        return { ...status, settings };
    },

    /** 仅保存设置；若服务器已在运行则按新配置重启，否则不强行启动 */
    async persistSettings(partial: Partial<MCPServerSettings>) {
        const merged = mergeSettings(partial);
        saveSettings(merged);
        await applyServerSettings(merged, true);
        return merged;
    },

    /** 保存并启动服务器（用于「启动服务器」按钮） */
    async updateSettings(partial: Partial<MCPServerSettings>) {
        const merged = mergeSettings(partial);
        saveSettings(merged);
        if (mcpServer) {
            mcpServer.stop();
        }
        mcpServer = new MCPServer(merged);
        mcpServer.updateEnabledTools(toolManager.getEnabledTools());
        await mcpServer.start();
        return merged;
    },

    getToolsList() {
        return mcpServer ? mcpServer.getAvailableTools() : [];
    },

    getFilteredToolsList() {
        if (!mcpServer) return [];
        const enabledTools = toolManager.getEnabledTools();
        mcpServer.updateEnabledTools(enabledTools);
        return mcpServer.getFilteredTools(enabledTools);
    },

    async getServerSettings() {
        return mcpServer ? mcpServer.getSettings() : readSettings();
    },

    // Alias kept for backwards compatibility with panel messages
    async getSettings() {
        return mcpServer ? mcpServer.getSettings() : readSettings();
    },

    async getToolManagerState() {
        return toolManager.getToolManagerState();
    },

    async createToolConfiguration(name: string, description?: string) {
        try {
            const config = toolManager.createConfiguration(name, description);
            return { success: true, id: config.id, config };
        } catch (error: any) {
            throw new Error(`Failed to create configuration: ${error.message}`);
        }
    },

    async updateToolConfiguration(configId: string, updates: any) {
        try {
            return toolManager.updateConfiguration(configId, updates);
        } catch (error: any) {
            throw new Error(`Failed to update configuration: ${error.message}`);
        }
    },

    async deleteToolConfiguration(configId: string) {
        try {
            toolManager.deleteConfiguration(configId);
            return { success: true };
        } catch (error: any) {
            throw new Error(`Failed to delete configuration: ${error.message}`);
        }
    },

    async setCurrentToolConfiguration(configId: string) {
        try {
            toolManager.setCurrentConfiguration(configId);
            return { success: true };
        } catch (error: any) {
            throw new Error(`Failed to set current configuration: ${error.message}`);
        }
    },

    async updateToolStatus(category: string, toolName: string, enabled: boolean) {
        try {
            const currentConfig = toolManager.getCurrentConfiguration();
            if (!currentConfig) {
                throw new Error('No active configuration');
            }
            toolManager.updateToolStatus(currentConfig.id, category, toolName, enabled);
            if (mcpServer) {
                mcpServer.updateEnabledTools(toolManager.getEnabledTools());
            }
            return { success: true };
        } catch (error: any) {
            throw new Error(`Failed to update tool status: ${error.message}`);
        }
    },

    async updateToolStatusBatch(updates: any[]) {
        try {
            const currentConfig = toolManager.getCurrentConfiguration();
            if (!currentConfig) {
                throw new Error('No active configuration');
            }
            toolManager.updateToolStatusBatch(currentConfig.id, updates);
            if (mcpServer) {
                mcpServer.updateEnabledTools(toolManager.getEnabledTools());
            }
            return { success: true };
        } catch (error: any) {
            throw new Error(`Failed to batch update tool status: ${error.message}`);
        }
    },

    async exportToolConfiguration(configId: string) {
        try {
            return { configJson: toolManager.exportConfiguration(configId) };
        } catch (error: any) {
            throw new Error(`Failed to export configuration: ${error.message}`);
        }
    },

    async importToolConfiguration(configJson: string) {
        try {
            return toolManager.importConfiguration(configJson);
        } catch (error: any) {
            throw new Error(`Failed to import configuration: ${error.message}`);
        }
    },

    async getEnabledTools() {
        return toolManager.getEnabledTools();
    }
};

export function load() {
    console.log('[MCP] Extension loaded');

    toolManager = new ToolManager();

    const settings = readSettings();
    mcpServer = new MCPServer(settings);
    mcpServer.updateEnabledTools(toolManager.getEnabledTools());

    // 构建实例(--build)不自动启动 MCP，避免与主编辑器抢 3000 端口导致构建卡死；主编辑器 MCP 保持常开
    const isBuildInstance = process.argv.includes('--build');
    if (settings.autoStart && !isBuildInstance) {
        scheduleAutoStart();
    }
}

/** Creator 刚启动时编辑器/项目可能尚未就绪，延迟并重试自动启动 */
function scheduleAutoStart(maxAttempts = 5, delayMs = 2000) {
    let attempt = 0;
    const tryStart = () => {
        attempt += 1;
        if (!mcpServer) {
            return;
        }
        mcpServer.start()
            .then(() => {
                console.log(`[MCP] Auto-start succeeded (attempt ${attempt})`);
            })
            .catch(err => {
                console.error(`[MCP] Auto-start attempt ${attempt}/${maxAttempts} failed:`, err);
                if (attempt < maxAttempts) {
                    setTimeout(tryStart, delayMs);
                }
            });
    };
    setTimeout(tryStart, delayMs);
}

export function unload() {
    if (mcpServer) {
        mcpServer.stop();
        mcpServer = null;
    }
}
