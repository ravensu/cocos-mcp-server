/** Asset DB completion and scene-process import visibility can settle on different ticks. */
export async function waitForAnimationImport<T>(
    probe: () => Promise<T>,
    wait: (milliseconds: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<{ value: T; attempts: number }> {
    const delays = [100, 200, 400, 800, 1000];
    for (let attempt = 0; ; ++attempt) {
        try { return { value: await probe(), attempts: attempt + 1 }; }
        catch (error: any) {
            // Retry only known import-readiness failures; never rewrite the asset or retry mutations.
            const transient = /CCON Format error|Animation import is not ready|Imported animation verification failed/.test(error.message || '');
            if (!transient || attempt >= delays.length) throw error;
            await wait(delays[attempt]);
        }
    }
}
