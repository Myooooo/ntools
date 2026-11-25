/**
 * zip.js — 极简 ZIP 打包（store-only，不压缩）
 * 经典脚本，无依赖。挂载：NC.zip
 *
 * 为什么自己写：导出整库时希望用户拿到一个能直接解压的压缩包，而不是
 * 上百个 .md 逐个下载。引入 zip 库又要多一个第三方依赖（体积 + 许可登记），
 * 而"只存储不压缩"的 ZIP 结构足够简单，几十行就能写对。
 *
 * 不解压：导入走应用自己的 JSON，不解析 ZIP。
 *
 * 用法：
 *   var bytes = NC.zip.build([{ name: '笔记/a.md', data: '正文' }, { name: 'b.md', data: uint8 }]);
 *   var blob = new Blob([bytes], { type: 'application/zip' });
 */
(function (global) {
    'use strict';

    var NC = global.NC = global.NC || {};

    /* CRC32 查表 */
    var CRC_TABLE = (function () {
        var table = new Uint32Array(256);
        for (var n = 0; n < 256; n += 1) {
            var c = n;
            for (var k = 0; k < 8; k += 1) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        var crc = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i += 1) {
            crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function utf8(text) {
        if (global.TextEncoder) return new TextEncoder().encode(String(text == null ? '' : text));
        /* 兜底：老内核（Chromium 102 有 TextEncoder，这里只是保险） */
        var escaped = unescape(encodeURIComponent(String(text == null ? '' : text)));
        var out = new Uint8Array(escaped.length);
        for (var i = 0; i < escaped.length; i += 1) out[i] = escaped.charCodeAt(i);
        return out;
    }

    function toBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        return utf8(data);
    }

    function dosTime(date) {
        var d = date || new Date();
        var year = Math.max(1980, Math.min(2107, d.getFullYear()));
        var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
        var day = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
        return { time: time, date: day };
    }

    /**
     * @param {Array<{name:string, data:string|Uint8Array}>} files
     * @param {{date?:Date}} [options]
     * @returns {Uint8Array}
     */
    function buildParts(files, options) {
        var opts = options || {};
        var stamp = dosTime(opts.date);
        var entries = [];
        var localParts = [];
        var offset = 0;

        (Array.isArray(files) ? files : []).forEach(function (file) {
            if (!file || !file.name) return;
            var nameBytes = utf8(file.name);
            var dataBytes = toBytes(file.data);
            var crc = crc32(dataBytes);

            var local = new Uint8Array(30 + nameBytes.length);
            var view = new DataView(local.buffer);
            view.setUint32(0, 0x04034b50, true);      // local file header
            view.setUint16(4, 20, true);             // version needed
            view.setUint16(6, 0x0800, true);         // flag: UTF-8 文件名
            view.setUint16(8, 0, true);              // method: store
            view.setUint16(10, stamp.time, true);
            view.setUint16(12, stamp.date, true);
            view.setUint32(14, crc, true);
            view.setUint32(18, dataBytes.length, true);
            view.setUint32(22, dataBytes.length, true);
            view.setUint16(26, nameBytes.length, true);
            view.setUint16(28, 0, true);
            local.set(nameBytes, 30);

            entries.push({
                nameBytes: nameBytes,
                crc: crc,
                size: dataBytes.length,
                offset: offset
            });
            localParts.push(local, dataBytes);
            offset += local.length + dataBytes.length;
        });

        var centralParts = [];
        var centralSize = 0;
        entries.forEach(function (entry) {
            var header = new Uint8Array(46 + entry.nameBytes.length);
            var view = new DataView(header.buffer);
            view.setUint32(0, 0x02014b50, true);     // central directory header
            view.setUint16(4, 20, true);             // version made by
            view.setUint16(6, 20, true);             // version needed
            view.setUint16(8, 0x0800, true);
            view.setUint16(10, 0, true);
            view.setUint16(12, stamp.time, true);
            view.setUint16(14, stamp.date, true);
            view.setUint32(16, entry.crc, true);
            view.setUint32(20, entry.size, true);
            view.setUint32(24, entry.size, true);
            view.setUint16(28, entry.nameBytes.length, true);
            view.setUint16(30, 0, true);
            view.setUint16(32, 0, true);
            view.setUint16(34, 0, true);
            view.setUint16(36, 0, true);
            view.setUint32(38, 0, true);
            view.setUint32(42, entry.offset, true);
            header.set(entry.nameBytes, 46);
            centralParts.push(header);
            centralSize += header.length;
        });

        var end = new Uint8Array(22);
        var endView = new DataView(end.buffer);
        endView.setUint32(0, 0x06054b50, true);
        endView.setUint16(4, 0, true);
        endView.setUint16(6, 0, true);
        endView.setUint16(8, entries.length, true);
        endView.setUint16(10, entries.length, true);
        endView.setUint32(12, centralSize, true);
        endView.setUint32(16, offset, true);
        endView.setUint16(20, 0, true);

        return { parts: localParts.concat(centralParts, [end]), total: offset + centralSize + end.length };
    }

    function build(files, options) {
        var built = buildParts(files, options);
        var out = new Uint8Array(built.total);
        var cursor = 0;
        built.parts.forEach(function (part) {
            out.set(part, cursor);
            cursor += part.length;
        });
        return out;
    }

    /** 零拷贝构造 ZIP Blob：避免弱机大备份时双倍连续内存分配导致 OOM */
    function buildBlob(files, options) {
        var built = buildParts(files, options);
        return new Blob(built.parts, { type: 'application/zip' });
    }

    NC.zip = {
        build: build,
        buildBlob: buildBlob,
        crc32: crc32
    };
})(window);
