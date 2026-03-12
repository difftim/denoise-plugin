export function collectTransferBuffers(
    buffers: Float32Array[],
    ...extraGroups: Array<Float32Array[] | undefined>
): ArrayBuffer[] {
    const transfer: ArrayBuffer[] = []

    for (let i = 0; i < buffers.length; i++) {
        transfer.push(buffers[i].buffer as ArrayBuffer)
    }

    for (let groupIndex = 0; groupIndex < extraGroups.length; groupIndex++) {
        const group = extraGroups[groupIndex]
        if (!group) continue

        for (let i = 0; i < group.length; i++) {
            transfer.push(group[i].buffer as ArrayBuffer)
        }
    }

    return transfer
}
