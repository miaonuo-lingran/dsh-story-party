/**
 * 零依赖 zip 读取（只支持 stored / deflate，足够剧情包用）。
 *
 * 安全边界：
 *   - 条目数 / 单条解压后大小 / 总解压大小都有上限（防 zip 炸弹）
 *   - 拒绝加密条目、拒绝 ../ 与绝对路径
 *   - 不落盘执行任何东西，只返回 { name, data }
 */
import { inflateRawSync } from 'node:zlib'

const MAX_ENTRIES = 200
const MAX_ENTRY_BYTES = 6 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是有效的 zip 文件')
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾）')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount > MAX_ENTRIES) throw new Error(`条目太多（${entryCount} > ${MAX_ENTRIES}）`)
  if (cdOffset >= buffer.length) throw new Error('zip 目录偏移越界')

  const files = []
  let total = 0
  let pointer = cdOffset

  for (let index = 0; index < entryCount; index++) {
    if (pointer + 46 > buffer.length) throw new Error('zip 目录被截断')
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('zip 目录项损坏')

    const flags = buffer.readUInt16LE(pointer + 8)
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
    pointer += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue // 目录项
    if (flags & 0x1) throw new Error('不支持加密的 zip')
    if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\')) {
      throw new Error(`非法的条目路径：${name}`)
    }

    if (localOffset + 30 > buffer.length) throw new Error('zip 条目偏移越界')
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip 条目头损坏')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) throw new Error('zip 条目数据越界')
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
    } else {
      throw new Error(`不支持的压缩方式：${method}`)
    }
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`条目太大：${name}`)
    total += data.length
    if (total > MAX_TOTAL_BYTES) throw new Error('解压后总大小超限')
    files.push({ name, data })
  }

  return files
}
