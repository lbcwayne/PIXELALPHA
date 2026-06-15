// ========== DOM 引用 ==========
const $ = (id) => document.getElementById(id);
const uploadInput = $('uploadInput');
const ratioSelect = $('ratioSelect');
const resRange = $('resRange');
const brightnessRange = $('brightnessRange');
const contrastRange = $('contrastRange');
const ditherRange = $('ditherRange');
const modeSelect = $('modeSelect');
const charInput = $('charInput');
const charInputGroup = $('charInputGroup');
const canvas = $('outputCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const colorInputs = [$('color0'), $('color1'), $('color2')];
const swatches = [$('swatch0'), $('swatch1'), $('swatch2')];
const colorBgInput = $('colorBg');
const swatchBg = $('swatchBg');

const brightVal = $('brightVal');
const contrastVal = $('contrastVal');
const ditherVal = $('ditherVal');

let originalImage = null;

// ✅ 2x2 Bayer 矩阵阈值，用于微像素模式的灰度映射
// 数值越小越容易亮起，形成从左上到右下的渐进纹理
const BAYER_MATRIX = [
    [0, 2],
    [3, 1]
];

// ========== 初始化 ==========
function initColors() {
    colorInputs.forEach((input, i) => {
        swatches[i].style.backgroundColor = input.value;
        input.addEventListener('input', () => {
            swatches[i].style.backgroundColor = input.value;
            render();
        });
    });
    swatchBg.style.backgroundColor = colorBgInput.value;
    colorBgInput.addEventListener('input', () => {
        swatchBg.style.backgroundColor = colorBgInput.value;
        render();
    });
}

[
    ratioSelect, resRange, brightnessRange, contrastRange, 
    ditherRange, modeSelect, charInput
].forEach(el => {
    el.addEventListener('input', () => {
        brightVal.textContent = brightnessRange.value;
        contrastVal.textContent = contrastRange.value;
        ditherVal.textContent = ditherRange.value + '%';
        charInputGroup.style.display = modeSelect.value === 'char' ? 'block' : 'none';
        render();
    });
});

uploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        originalImage = new Image();
        originalImage.onload = () => render();
        originalImage.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

// ========== 核心渲染引擎 ==========
function render() {
    if (!originalImage) return;

    const resolution = parseInt(resRange.value);
    const ratio = ratioSelect.value;
    const brightness = parseInt(brightnessRange.value);
    const contrast = parseInt(contrastRange.value);
    const ditherStrength = parseInt(ditherRange.value) / 100;
    const mode = modeSelect.value;
    const char = charInput.value || '#';
    const bgColor = colorBgInput.value;
    const palette = colorInputs.map(input => hexToRgb(input.value));

    // 1. 计算网格尺寸
    let cols = resolution;
    let rows = Math.round((originalImage.height / originalImage.width) * cols);
    
    if (ratio !== 'auto') {
        const [rw, rh] = ratio.split(':').map(Number);
        const targetRatio = rw / rh;
        if (originalImage.width / originalImage.height > targetRatio) {
            cols = resolution;
            rows = Math.round(resolution / targetRatio);
        } else {
            rows = resolution;
            cols = Math.round(resolution * targetRatio);
        }
    }

    // ✅ 微像素模式下，内部渲染分辨率翻倍以获得 2x2 子像素细节
    const subDiv = mode === 'micro' ? 2 : 1;
    const renderCols = cols * subDiv;
    const renderRows = rows * subDiv;

    const cellSize = Math.max(4, Math.min(800 / cols, 800 / rows));
    canvas.width = cols * cellSize;
    canvas.height = rows * cellSize;

    // 2. 预处理画布
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = renderCols;
    tempCanvas.height = renderRows;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    tempCtx.imageSmoothingEnabled = false;

    const cFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    tempCtx.filter = `brightness(${100 + brightness}%) contrast(${cFactor * 100}%)`;

    const srcRatio = originalImage.width / originalImage.height;
    const dstRatio = renderCols / renderRows;
    let sx = 0, sy = 0, sw = originalImage.width, sh = originalImage.height;
    
    if (ratio !== 'auto') {
        if (srcRatio > dstRatio) {
            sw = originalImage.height * dstRatio;
            sx = (originalImage.width - sw) / 2;
        } else {
            sh = originalImage.width / dstRatio;
            sy = (originalImage.height - sh) / 2;
        }
    }
    tempCtx.drawImage(originalImage, sx, sy, sw, sh, 0, 0, renderCols, renderRows);

    // 3. Alpha感知 + 抖动处理
    const imageData = tempCtx.getImageData(0, 0, renderCols, renderRows);
    const data = imageData.data;
    
    const alphaMap = new Uint8Array(renderCols * renderRows);
    for (let i = 0; i < alphaMap.length; i++) {
        alphaMap[i] = data[i * 4 + 3] < 128 ? 0 : 255;
    }

    // ✅ 仅在非微像素模式下执行标准 FS 抖动
    // 微像素模式依靠 Bayer 矩阵本身产生纹理，叠加 FS 抖动会导致噪点混乱
    if (mode !== 'micro') {
        for (let y = 0; y < renderRows; y++) {
            for (let x = 0; x < renderCols; x++) {
                const idx = y * renderCols + x;
                const i = idx * 4;
                
                if (alphaMap[idx] === 0) {
                    data[i+3] = 0;
                    continue;
                }

                const oldR = data[i], oldG = data[i+1], oldB = data[i+2];
                const closest = getClosestColor(oldR, oldG, oldB, palette);
                
                data[i] = closest[0]; 
                data[i+1] = closest[1]; 
                data[i+2] = closest[2];
                data[i+3] = 255;

                const errR = (oldR - closest[0]) * ditherStrength;
                const errG = (oldG - closest[1]) * ditherStrength;
                const errB = (oldB - closest[2]) * ditherStrength;

                if (x + 1 < renderCols && alphaMap[idx + 1])           
                    distributeError(data, renderCols, x+1, y, errR, errG, errB, 7/16);
                if (x-1 >= 0 && y+1 < renderRows && alphaMap[idx + renderCols - 1])     
                    distributeError(data, renderCols, x-1, y+1, errR, errG, errB, 3/16);
                if (y+1 < renderRows && alphaMap[idx + renderCols])                 
                    distributeError(data, renderCols, x, y+1, errR, errG, errB, 5/16);
                if (x+1 < renderCols && y+1 < renderRows && alphaMap[idx + renderCols + 1])   
                    distributeError(data, renderCols, x+1, y+1, errR, errG, errB, 1/16);
            }
        }
    }

    // 4. 绘制到主画布
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const subCellSize = cellSize / subDiv;

    for (let y = 0; y < renderRows; y++) {
        for (let x = 0; x < renderCols; x++) {
            const idx = y * renderCols + x;
            if (alphaMap[idx] === 0) continue;

            const i = idx * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            const px = x * subCellSize, py = y * subCellSize;

            // ✅ 微像素模式专属渲染逻辑
            if (mode === 'micro') {
                // 计算当前子像素在 2x2 网格中的位置
                const bx = x % 2;
                const by = y % 2;
                const threshold = BAYER_MATRIX[by][bx]; // 0~3
                
                // 将 RGB 转为感知亮度 (0~1)
                const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                
                // 根据亮度和 Bayer 阈值决定该子像素是否点亮
                // 亮度越高，越多的子像素被点亮，形成自然的灰度过渡
                const shouldDraw = luminance > (threshold + 0.5) / 4;
                
                if (shouldDraw) {
                    // 找到最接近的调色板颜色
                    const closest = getClosestColor(r, g, b, palette);
                    ctx.fillStyle = `rgb(${closest[0]},${closest[1]},${closest[2]})`;
                    // 子像素之间留 0.5px 缝隙，增强网格融合感
                    ctx.fillRect(px, py, subCellSize - 0.5, subCellSize - 0.5);
                }
            } else if (mode === 'square') {
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillRect(px, py, cellSize, cellSize);
            } else if (mode === 'circle') {
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.beginPath();
                ctx.arc(px + cellSize/2, py + cellSize/2, cellSize/2 - 0.5, 0, Math.PI*2);
                ctx.fill();
            } else if (mode === 'char') {
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.font = `${cellSize * 0.8}px monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(char, px + cellSize/2, py + cellSize/2 + cellSize*0.05);
            }
        }
    }
}

// ========== 导出系统 ==========
function saveCanvas(format) {
    if (!originalImage) return alert('Please upload an image first / 请先上传图片');
    
    if (format === 'png') {
        const tempExportCanvas = document.createElement('canvas');
        tempExportCanvas.width = canvas.width;
        tempExportCanvas.height = canvas.height;
        const tCtx = tempExportCanvas.getContext('2d');
        
        const srcData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const dstData = tCtx.createImageData(canvas.width, canvas.height);
        const bgRgb = hexToRgb(colorBgInput.value);
        
        for (let i = 0; i < srcData.data.length; i += 4) {
            const r = srcData.data[i], g = srcData.data[i+1], b = srcData.data[i+2];
            if (r === bgRgb[0] && g === bgRgb[1] && b === bgRgb[2]) {
                dstData.data[i+3] = 0;
            } else {
                dstData.data[i] = r;
                dstData.data[i+1] = g;
                dstData.data[i+2] = b;
                dstData.data[i+3] = 255;
            }
        }
        tCtx.putImageData(dstData, 0, 0);
        
        const link = document.createElement('a');
        link.download = 'blockpro-transparent.png';
        link.href = tempExportCanvas.toDataURL('image/png');
        link.click();
    } else {
        const link = document.createElement('a');
        link.download = 'blockpro-export.jpg';
        link.href = canvas.toDataURL('image/jpeg', 0.92);
        link.click();
    }
}

$('downloadPngBtn').addEventListener('click', () => saveCanvas('png'));
$('downloadJpgBtn').addEventListener('click', () => saveCanvas('jpg'));

$('exportSvgBtn').addEventListener('click', () => {
    if (!originalImage) return alert('Please upload an image first / 请先上传图片');
    
    const mode = modeSelect.value;
    const char = charInput.value || '#';
    const bgColor = colorBgInput.value;
    const w = canvas.width, h = canvas.height;
    
    // SVG 导出时统一按主网格采样
    const cols = parseInt(resRange.value);
    const ratio = ratioSelect.value;
    let rows = Math.round((originalImage.height / originalImage.width) * cols);
    if (ratio !== 'auto') {
        const [rw, rh] = ratio.split(':').map(Number);
        const targetRatio = rw / rh;
        if (originalImage.width / originalImage.height > targetRatio) {
            rows = Math.round(cols / targetRatio);
        } else {
            rows = cols;
            cols = Math.round(cols * targetRatio);
        }
    }

    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = cols;
    sampleCanvas.height = rows;
    const sCtx = sampleCanvas.getContext('2d');
    sCtx.imageSmoothingEnabled = false;
    sCtx.drawImage(canvas, 0, 0, cols, rows);
    const data = sCtx.getImageData(0, 0, cols, rows).data;
    const bgRgb = hexToRgb(bgColor);

    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${cols} ${rows}" shape-rendering="crispEdges">\n<rect width="100%" height="100%" fill="${bgColor}"/>\n`;

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = (y * cols + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
            
            if (a < 128) continue;
            if (r === bgRgb[0] && g === bgRgb[1] && b === bgRgb[2]) continue;
            
            const hex = rgbToHex(r, g, b);

            if (mode === 'square' || mode === 'micro') {
                // 微像素模式在 SVG 中降级为方块以保持文件轻量
                svg += `<rect x="${x}" y="${y}" width="1" height="1" fill="${hex}"/>\n`;
            } else if (mode === 'circle') {
                svg += `<circle cx="${x+0.5}" cy="${y+0.5}" r="0.45" fill="${hex}"/>\n`;
            } else if (mode === 'char') {
                svg += `<text x="${x+0.5}" y="${y+0.6}" font-size="0.8" text-anchor="middle" fill="${hex}" font-family="monospace">${escapeXml(char)}</text>\n`;
            }
        }
    }
    svg += '</svg>';

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'blockpro-vector.svg';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
});

// ========== 工具函数 ==========
function getClosestColor(r, g, b, palette) {
    let minDist = Infinity, closest = palette[0];
    for (const c of palette) {
        const dist = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2;
        if (dist < minDist) { minDist = dist; closest = c; }
    }
    return closest;
}

function distributeError(data, cols, x, y, eR, eG, eB, w) {
    const i = (y * cols + x) * 4;
    data[i]   = Math.min(255, Math.max(0, data[i]   + eR * w));
    data[i+1] = Math.min(255, Math.max(0, data[i+1] + eG * w));
    data[i+2] = Math.min(255, Math.max(0, data[i+2] + eB * w));
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n>>16)&255, (n>>8)&255, n&255];
}

function rgbToHex(r, g, b) {
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

function escapeXml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

initColors();
