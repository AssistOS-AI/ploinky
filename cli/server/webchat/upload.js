import {
    formatBytes,
    getFileIcon,
    canvasToBlob,
    openCameraInputFallback,
    loadQrLib,
} from './fileHelpers.js';
import {
    buildUploadSelectionRoots,
    createUploadDestinationDialog,
    joinUploadPath,
} from './uploadDestinationDialog.js';

function createCameraOverlay({ composer }) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return null;
    }

    const overlay = document.createElement('div');
    overlay.className = 'wa-camera-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <div class="wa-camera-dialog">
            <div class="wa-camera-mode-toggle" role="tablist">
                <button type="button" class="wa-camera-mode active" data-camera-mode="photo" role="tab" aria-selected="true">Photo</button>
                <button type="button" class="wa-camera-mode" data-camera-mode="scan" role="tab" aria-selected="false">Scan QR</button>
            </div>
            <div class="wa-camera-view">
                <video class="wa-camera-video" autoplay playsinline></video>
                <img class="wa-camera-preview" alt="Captured photo preview" hidden />
            </div>
            <div class="wa-camera-footer">
                <div class="wa-camera-error" role="status" aria-live="polite"></div>
                <div class="wa-camera-scan-status" aria-live="polite" hidden></div>
                <div class="wa-camera-actions">
                    <button type="button" class="wa-camera-btn wa-camera-btn-primary" data-action="capture">Capture</button>
                    <button type="button" class="wa-camera-btn" data-action="retake" hidden>Retake</button>
                    <button type="button" class="wa-camera-btn wa-camera-btn-primary" data-action="use" hidden>Use photo</button>
                    <button type="button" class="wa-camera-btn" data-action="cancel">Close</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const video = overlay.querySelector('.wa-camera-video');
    const preview = overlay.querySelector('.wa-camera-preview');
    const modeButtons = Array.from(overlay.querySelectorAll('[data-camera-mode]'));
    const captureBtn = overlay.querySelector('[data-action="capture"]');
    const retakeBtn = overlay.querySelector('[data-action="retake"]');
    const useBtn = overlay.querySelector('[data-action="use"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const errorEl = overlay.querySelector('.wa-camera-error');
    const scanStatusEl = overlay.querySelector('.wa-camera-scan-status');

    const canvas = document.createElement('canvas');
    const captureCtx = canvas.getContext('2d');
    const scanCanvas = document.createElement('canvas');
    const scanCtx = scanCanvas.getContext('2d');

    let stream = null;
    let resolver = null;
    let rejecter = null;
    let active = false;
    let objectUrl = null;
    let capturedBlob = null;
    let selectedMode = 'photo';
    let defaultMode = 'photo';
    let scanning = false;
    let scanAnimation = null;

    function setError(message) {
        if (!errorEl) {
            return;
        }
        errorEl.textContent = message || '';
        errorEl.hidden = !message;
    }

    function setModeButtons(mode) {
        modeButtons.forEach((btn) => {
            const isActive = btn.dataset.cameraMode === mode;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
    }

    function stopScan(resetStatus = false) {
        if (scanAnimation !== null) {
            cancelAnimationFrame(scanAnimation);
            scanAnimation = null;
        }
        scanning = false;
        if (resetStatus && scanStatusEl) {
            scanStatusEl.textContent = '';
            scanStatusEl.hidden = true;
        }
    }

    function stopStream() {
        if (stream) {
            const tracks = stream.getTracks ? stream.getTracks() : [];
            tracks.forEach((track) => {
                try {
                    track.stop();
                } catch (_) {
                    // Ignore stop failures
                }
            });
        }
        stream = null;
        if (video) {
            video.srcObject = null;
        }
    }

    function resetPreview() {
        if (preview) {
            preview.hidden = true;
            preview.src = '';
        }
        if (video) {
            video.hidden = false;
        }
        capturedBlob = null;
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }
    }

    function resetUi() {
        stopScan(true);
        resetPreview();
        if (captureBtn) {
            captureBtn.hidden = false;
            captureBtn.disabled = true;
        }
        if (retakeBtn) {
            retakeBtn.hidden = true;
        }
        if (useBtn) {
            useBtn.hidden = true;
        }
        if (scanStatusEl) {
            scanStatusEl.textContent = '';
            scanStatusEl.hidden = true;
        }
        setError('');
    }

    function cleanup() {
        active = false;
        document.removeEventListener('keydown', handleKeydown, true);
        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
        stopScan(true);
        stopStream();
        resetUi();
        resolver = null;
        rejecter = null;
    }

    function resolveWith(value) {
        defaultMode = selectedMode;
        const resolveFn = resolver;
        cleanup();
        if (resolveFn) {
            resolveFn(value);
        }
    }

    function rejectWith(error) {
        defaultMode = selectedMode;
        const rejectFn = rejecter;
        cleanup();
        if (rejectFn) {
            rejectFn(error);
        }
    }

    async function beginStream() {
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
            if (video) {
                video.srcObject = stream;
                await video.play().catch(() => {});
                if (selectedMode === 'photo' && captureBtn) {
                    captureBtn.disabled = false;
                    captureBtn.focus();
                }
            }
        } catch (error) {
            setError('Unable to access camera. Check permissions and try again.');
            throw error;
        }
    }

    async function startScanLoop() {
        if (scanning) {
            return;
        }
        if (!scanCtx) {
            setError('QR scanning unavailable in this browser.');
            return;
        }
        scanning = true;
        if (scanStatusEl) {
            scanStatusEl.hidden = false;
            scanStatusEl.textContent = stream ? 'Point the camera at a QR code.' : 'Starting camera…';
        }
        try {
            const qrLib = await loadQrLib();
            const run = () => {
                if (!scanning) {
                    return;
                }
                if (!video || !video.videoWidth || !video.videoHeight) {
                    if (scanStatusEl) {
                        scanStatusEl.textContent = 'Starting camera…';
                    }
                    scanAnimation = requestAnimationFrame(run);
                    return;
                }
                const width = video.videoWidth;
                const height = video.videoHeight;
                if (scanCanvas.width !== width) {
                    scanCanvas.width = width;
                }
                if (scanCanvas.height !== height) {
                    scanCanvas.height = height;
                }
                try {
                    scanCtx.drawImage(video, 0, 0, width, height);
                    const imageData = scanCtx.getImageData(0, 0, width, height);
                    const decoded = qrLib.decodeQR(imageData, { cropToSquare: true });
                    if (decoded) {
                        handleScanSuccess(String(decoded));
                        return;
                    }
                } catch (_) {
                    // decode errors are expected until a QR code is found
                }
                if (scanStatusEl) {
                    scanStatusEl.textContent = 'Point the camera at a QR code.';
                }
                scanAnimation = requestAnimationFrame(run);
            };
            scanAnimation = requestAnimationFrame(run);
        } catch (error) {
            scanning = false;
            if (scanStatusEl) {
                scanStatusEl.hidden = true;
            }
            setError(error.message || 'Unable to start QR scanning.');
        }
    }

    async function captureFrame() {
        if (selectedMode !== 'photo') {
            return;
        }
        if (!video || !stream) {
            setError('Camera is not ready.');
            return;
        }
        if (!captureCtx) {
            setError('Unable to prepare capture buffer.');
            return;
        }
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) {
            setError('Camera is still initializing. Please try again.');
            return;
        }
        canvas.width = width;
        canvas.height = height;
        captureCtx.drawImage(video, 0, 0, width, height);
        try {
            capturedBlob = await canvasToBlob(canvas);
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
            objectUrl = URL.createObjectURL(capturedBlob);
            if (preview) {
                preview.src = objectUrl;
                preview.hidden = false;
            }
            if (video) {
                video.hidden = true;
            }
            if (captureBtn) {
                captureBtn.hidden = true;
            }
            if (retakeBtn) {
                retakeBtn.hidden = false;
            }
            if (useBtn) {
                useBtn.hidden = false;
            }
            setError('');
        } catch (error) {
            setError('Failed to capture photo. Please try again.');
            capturedBlob = null;
        }
    }

    function handleRetake() {
        if (selectedMode !== 'photo') {
            return;
        }
        resetPreview();
        if (video) {
            video.hidden = false;
            video.play().catch(() => {});
        }
        if (captureBtn) {
            captureBtn.hidden = false;
            captureBtn.disabled = false;
        }
        if (retakeBtn) {
            retakeBtn.hidden = true;
        }
        if (useBtn) {
            useBtn.hidden = true;
        }
        setError('');
    }

    async function handleUse() {
        if (selectedMode !== 'photo') {
            return;
        }
        if (!capturedBlob) {
            setError('No photo captured yet.');
            return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `camera-${timestamp}.jpg`;
        const file = new File([capturedBlob], fileName, { type: capturedBlob.type || 'image/jpeg' });
        resolveWith(file);
    }

    function handleScanSuccess(rawValue) {
        stopScan(false);
        const decoded = String(rawValue || '').trim();
        if (!decoded) {
            if (scanStatusEl) {
                scanStatusEl.textContent = 'QR code is empty.';
            }
            return;
        }
        if (scanStatusEl) {
            scanStatusEl.textContent = `Found: ${decoded}`;
        }

        if (composer && typeof composer.setValue === 'function') {
            try {
                composer.setValue(decoded);
                if (typeof composer.focus === 'function') {
                    composer.focus();
                }
            } catch (error) {
                setError('Failed to populate scanned code.');
                return;
            }
        }
        resolveWith(null);
    }

    function handleCancel() {
        resolveWith(null);
    }

    function handleKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            handleCancel();
        }
    }

    function switchMode(mode, { force = false } = {}) {
        if (mode !== 'scan' && mode !== 'photo') {
            mode = 'photo';
        }
        if (selectedMode === mode && !force) {
            if (mode === 'scan' && !scanning) {
                startScanLoop();
            }
            return;
        }
        selectedMode = mode;
        setModeButtons(mode);
        setError('');
        if (mode === 'photo') {
            stopScan(true);
            if (captureBtn) {
                captureBtn.hidden = false;
                captureBtn.disabled = !stream;
            }
            if (!capturedBlob) {
                if (preview) preview.hidden = true;
                if (video) video.hidden = false;
                if (retakeBtn) retakeBtn.hidden = true;
                if (useBtn) useBtn.hidden = true;
            } else {
                if (preview) preview.hidden = false;
                if (video) video.hidden = true;
                if (retakeBtn) retakeBtn.hidden = false;
                if (useBtn) useBtn.hidden = false;
            }
            if (scanStatusEl) {
                scanStatusEl.textContent = '';
                scanStatusEl.hidden = true;
            }
        } else {
            resetPreview();
            if (captureBtn) {
                captureBtn.hidden = true;
                captureBtn.disabled = true;
            }
            if (retakeBtn) {
                retakeBtn.hidden = true;
            }
            if (useBtn) {
                useBtn.hidden = true;
            }
            if (video) {
                video.hidden = false;
            }
            if (scanStatusEl) {
                scanStatusEl.hidden = false;
                scanStatusEl.textContent = stream ? 'Point the camera at a QR code.' : 'Starting camera…';
            }
            startScanLoop();
        }
    }

    captureBtn?.addEventListener('click', () => {
        captureFrame();
    });

    retakeBtn?.addEventListener('click', () => {
        handleRetake();
    });

    useBtn?.addEventListener('click', () => {
        handleUse();
    });

    cancelBtn?.addEventListener('click', () => {
        handleCancel();
    });

    modeButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.cameraMode === 'scan' ? 'scan' : 'photo';
            defaultMode = mode;
            switchMode(mode, { force: true });
        });
    });

    return {
        open() {
            if (active) {
                return Promise.resolve(null);
            }
            active = true;
            overlay.classList.add('show');
            overlay.removeAttribute('aria-hidden');
            resetUi();
            selectedMode = defaultMode;
            setModeButtons(selectedMode);
            switchMode(selectedMode, { force: true });
            document.addEventListener('keydown', handleKeydown, true);
            return new Promise((resolve, reject) => {
                resolver = resolve;
                rejecter = reject;
                beginStream()
                    .then(() => {
                        if (selectedMode === 'photo' && captureBtn) {
                            captureBtn.disabled = false;
                        }
                    })
                    .catch((error) => {
                        rejectWith(error);
                    });
            });
        }
    };
}

export function createUploader({
    attachmentBtn,
    attachmentMenu,
    uploadFileBtn,
    uploadFolderBtn,
    cameraActionBtn,
    fileUploadInput,
    folderUploadInput,
    filePreviewContainer,
    attachmentContainer,
}, { composer, toEndpoint }) {

    const selections = [];
    let cameraOverlay;
    const destinationDialog = createUploadDestinationDialog({ toEndpoint, composer });
    const refocusComposer = () => {
        if (!composer || typeof composer.focus !== 'function') {
            return;
        }
        setTimeout(() => {
            try {
                composer.focus();
            } catch (_) {
                // Ignore focus issues
            }
        }, 0);
    };

    function toggleMenu(e) {
        e.stopPropagation();
        attachmentMenu.classList.toggle('show');
    }

    function openFilePicker() {
        fileUploadInput.click();
        attachmentMenu.classList.remove('show');
        refocusComposer();
    }

    function openFolderPicker() {
        if (!folderUploadInput) {
            return;
        }
        folderUploadInput.click();
        attachmentMenu.classList.remove('show');
        refocusComposer();
    }

    function sanitizeRelativePath(rawPath, fallbackName) {
        const candidate = (typeof rawPath === 'string' && rawPath.trim()) ? rawPath : (fallbackName || '');
        if (!candidate) {
            return '';
        }
        const normalized = String(candidate).replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
        const segments = normalized.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
        return segments.join('/');
    }

    function updatePreviewVisibility() {
        if (selections.length > 0) {
            filePreviewContainer.classList.add('show');
        } else {
            filePreviewContainer.classList.remove('show');
            filePreviewContainer.innerHTML = '';
        }
        composer.autoResize();
        refocusComposer();
    }

    function createSelectionPreview(selection) {
        const { file, isImage } = selection;
        const item = document.createElement('div');
        item.className = 'wa-file-preview-item';
        item.dataset.selectionId = selection.id;

        let thumbnailHTML = '';
        if (isImage) {
            thumbnailHTML = '<div class="wa-file-preview-thumbnail"><img src="" alt="Preview"></div>';
        } else {
            thumbnailHTML = `<div class="wa-file-preview-thumbnail">${getFileIcon(file.name)}</div>`;
        }

        item.innerHTML = `
            ${thumbnailHTML}
            <div class="wa-file-preview-info">
                <div class="wa-file-preview-name"></div>
                <div class="wa-file-preview-size"></div>
            </div>
            <button class="wa-file-preview-remove" title="Remove file">&times;</button>
        `;

        const relativePath = selection.relativePath;
        const previewName = joinUploadPath(selection.destinationPath, relativePath) || file.name;
        item.querySelector('.wa-file-preview-name').textContent = previewName;
        item.querySelector('.wa-file-preview-size').textContent = formatBytes(file.size);

        if (isImage) {
            const reader = new FileReader();
            reader.onload = (e) => {
                selection.previewDataUrl = typeof e.target?.result === 'string' ? e.target.result : null;
                const previewImg = item.querySelector('img');
                if (previewImg && selection.previewDataUrl) {
                    previewImg.src = selection.previewDataUrl;
                }
            };
            reader.readAsDataURL(file);
        }

        item.querySelector('.wa-file-preview-remove').onclick = (e) => {
            e.stopPropagation();
            removeSelection(selection.id);
        };

        selection.domItem = item;
        filePreviewContainer.appendChild(item);
    }

    function addSelection(file, options = {}) {
        if (!file) {
            return;
        }
        const rawRelative = typeof options.relativePath === 'string' && options.relativePath
            ? options.relativePath
            : (file.webkitRelativePath || file.name || '');
        const relativePath = sanitizeRelativePath(rawRelative, file.name) || file.name || '';
        const selection = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            file,
            isImage: (file.type || '').startsWith('image/'),
            previewDataUrl: null,
            domItem: null,
            relativePath,
            destinationPath: sanitizeRelativePath(options.destinationPath || '', ''),
            overwrite: options.overwrite === true,
        };
        selections.push(selection);
        createSelectionPreview(selection);
        updatePreviewVisibility();
    }

    function removeSelection(id) {
        const index = selections.findIndex((sel) => sel.id === id);
        if (index === -1) {
            return;
        }
        const [removed] = selections.splice(index, 1);
        if (removed?.domItem && removed.domItem.parentNode === filePreviewContainer) {
            filePreviewContainer.removeChild(removed.domItem);
        }
        updatePreviewVisibility();
        if (selections.length === 0) {
            fileUploadInput.value = '';
        }
        refocusComposer();
    }

    async function queueSelectedFiles(files, mode) {
        const pending = files.map((file) => ({
            file,
            relativePath: sanitizeRelativePath(
                mode === 'folder' ? (file.webkitRelativePath || file.name || '') : (file.name || ''),
                file.name,
            ),
        })).filter((selection) => selection.relativePath);
        if (!pending.length) return;
        const roots = buildUploadSelectionRoots(pending, mode);
        const summary = mode === 'folder'
            ? `Folder: ${roots[0]?.name || 'selected folder'}`
            : `${pending.length} file${pending.length === 1 ? '' : 's'} selected`;
        const destination = await destinationDialog.open({ roots, summary });
        if (!destination) return;
        const overwriteRoots = new Set(destination.overwriteRoots || []);
        pending.forEach((selection) => {
            const rootName = selection.relativePath.split('/')[0];
            addSelection(selection.file, {
                relativePath: selection.relativePath,
                destinationPath: destination.destinationPath,
                overwrite: overwriteRoots.has(rootName),
            });
        });
    }

    async function handleFileSelection(event) {
        try {
            const files = Array.from(event.target.files || []);
            if (!files.length) {
                return;
            }
            await queueSelectedFiles(files, 'file');
            fileUploadInput.value = '';
        } finally {
            refocusComposer();
        }
    }

    async function handleFolderSelection(event) {
        try {
            const files = Array.from(event.target.files || []);
            if (!files.length) {
                return;
            }
            await queueSelectedFiles(files, 'folder');
            if (folderUploadInput) {
                folderUploadInput.value = '';
            }
        } finally {
            refocusComposer();
        }
    }
    
    function getCameraOverlay() {
        if (cameraOverlay === undefined) {
            cameraOverlay = createCameraOverlay({ composer });
        }
        return cameraOverlay;
    }

    async function handleCameraClick(event) {
        event.preventDefault();
        event.stopPropagation();
        attachmentMenu.classList.remove('show');

        try {
            const overlay = getCameraOverlay();
            if (overlay) {
                try {
                    const file = await overlay.open();
                    if (file instanceof File) {
                        await queueSelectedFiles([file], 'file');
                    }
                    return;
                } catch (error) {
                    console.warn('Camera capture failed, falling back to file input', error);
                }
            }
            const fallbackFile = await openCameraInputFallback();
            if (fallbackFile) {
                await queueSelectedFiles([fallbackFile], 'file');
            }
        } finally {
            refocusComposer();
        }
    }

    function clearFiles() {
        while (selections.length) {
            const selection = selections.pop();
            if (selection?.domItem && selection.domItem.parentNode === filePreviewContainer) {
                filePreviewContainer.removeChild(selection.domItem);
            }
        }
        fileUploadInput.value = '';
        if (folderUploadInput) {
            folderUploadInput.value = '';
        }
        filePreviewContainer.replaceChildren();
        filePreviewContainer.classList.remove('show');
        updatePreviewVisibility();
    }

    attachmentBtn.addEventListener('click', toggleMenu);
    uploadFileBtn.addEventListener('click', openFilePicker);
    fileUploadInput.addEventListener('change', handleFileSelection);
    if (uploadFolderBtn && folderUploadInput) {
        uploadFolderBtn.addEventListener('click', openFolderPicker);
        folderUploadInput.addEventListener('change', handleFolderSelection);
    }
    cameraActionBtn?.addEventListener('click', handleCameraClick);
    
    document.addEventListener('click', (e) => {
        if (attachmentMenu.classList.contains('show') && !attachmentContainer.contains(e.target)) {
            attachmentMenu.classList.remove('show');
        }
    });

    return {
        getSelectedFiles: () => {
            if (!selections.length) {
                return [];
            }
            return selections.map((selection) => {
                let previewUrl = null;
                let revokePreview = null;
                if (selection.isImage) {
                    if (selection.previewDataUrl) {
                        previewUrl = selection.previewDataUrl;
                    } else {
                        previewUrl = URL.createObjectURL(selection.file);
                        revokePreview = () => {
                            try {
                                URL.revokeObjectURL(previewUrl);
                            } catch (_) {
                                // Ignore revoke failures
                            }
                        };
                    }
                }
                return {
                    file: selection.file,
                    previewUrl,
                    previewNeedsRevoke: typeof revokePreview === 'function',
                    revokePreview,
                    isImage: selection.isImage,
                    relativePath: selection.relativePath || selection.file.name || '',
                    destinationPath: selection.destinationPath || '',
                    overwrite: selection.overwrite === true,
                };
            });
        },
        clearFile: clearFiles,
        clearFiles,
    };
}
