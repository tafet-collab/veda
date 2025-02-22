import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import JSON5 from 'json5';
import p from 'pify';
import { throttle } from 'lodash';
import type { ImportedHash, Rc, RcDiff, RcFragment, RcPass } from './types';

interface FileData {
    filename: string;
    data: string;
}

const DEFAULT_RC = {
    glslangValidatorPath: '',
    IMPORTED: {},
    PASSES: [],
    pixelRatio: 2,
    frameskip: 2,
    vertexMode: 'LINE_STRIP',
    vertexCount: 3000,
    fftSize: 2048,
    fftSmoothingTimeConstant: 0.8,
    audio: false,
    midi: false,
    keyboard: false,
    gamepad: false,
    camera: false,
    glslify: false,
    server: null,
    osc: null,
    soundLength: 30,
};

function resolvePath(val: string, projectPath: string): string {
    if (val.match('https?://')) {
        return val;
    }
    return path.resolve(projectPath, val);
}

function parseImported(
    projectPath: string,
    importedHash?: ImportedHash,
): ImportedHash | null {
    if (!importedHash) {
        return null;
    }
    const newImportedHash: ImportedHash = {};

    Object.keys(importedHash).forEach((key): void => {
        const imported = importedHash[key];
        if (!imported || !imported.PATH) {
            return;
        }
        let importedPath = imported.PATH;

        if (!/^\//.test(importedPath)) {
            importedPath = resolvePath(importedPath, projectPath);
        }

        newImportedHash[key] = {
            PATH: importedPath,
        };
        if (imported.SPEED) {
            newImportedHash[key].SPEED = imported.SPEED;
        }
    });

    return newImportedHash;
}

function fixPath(projectPath: string, rc: RcFragment): RcFragment {
    const PASSES = (rc.PASSES || []).map((pass): RcPass => {
        if (pass.MODEL && pass.MODEL.PATH) {
            pass.MODEL.PATH = resolvePath(pass.MODEL.PATH, projectPath);
        }
        if (pass.MODEL && pass.MODEL.MATERIAL) {
            pass.MODEL.MATERIAL = resolvePath(pass.MODEL.MATERIAL, projectPath);
        }
        return pass;
    });

    return {
        ...rc,
        IMPORTED: parseImported(projectPath, rc.IMPORTED) || {},
        PASSES,
    };
}

export default class Config extends EventEmitter {
    public rc: Rc;
    public soundRc: Rc;
    public projectPath: string;

    private globalRc: RcFragment = {};
    private projectRc: RcFragment = {};
    private fileRc: RcFragment = {};
    private soundFileRc: RcFragment = {};
    private isWatching: boolean = false;

    public constructor(projectPath: string, rc: RcFragment) {
        super();

        this.rc = DEFAULT_RC;
        this.soundRc = DEFAULT_RC;
        this.setGlobalSettings(rc);

        this.projectPath = projectPath;
        if (projectPath) {
            fs.watch(projectPath, (_, filename): void => {
                if (filename === '.liverc' || filename === '.vedarc') {
                    this.load();
                }
            });
        }
    }

    public play(): void {
        this.isWatching = true;
        this.load();
    }

    public stop(): void {
        this.isWatching = false;
        this.rc = DEFAULT_RC;
        this.soundRc = DEFAULT_RC;
    }

    private readConfigFile = (filename: string): Promise<FileData> => {
        return p(fs.readFile)(
            path.resolve(this.projectPath, filename),
            'utf8',
        ).then((data: string): FileData => ({ filename, data }));
    };

    private load = (): Promise<void> | null => {
        if (!this.isWatching) {
            return null;
        }

        // Load .liverc or .vedarc
        return this.readConfigFile('.liverc')
            .then((d): FileData => {
                console.log(
                    '[VEDA] `.liverc` is deprecated. Use `.vedarc` instead.',
                );
                return d;
            })
            .catch((): Promise<FileData> => this.readConfigFile('.vedarc'))
            .then(({ filename, data }: FileData): void => {
                try {
                    const rc = fixPath(this.projectPath, JSON5.parse(data));
                    this.setProjectSettings(rc);
                } catch (e) {
                    console.log('[VEDA] Failed to parse rc file:', filename);
                }
            })
            .catch((): void => {
                console.log('[VEDA] config file not found');
            });
    };

    public createRc(): Rc {
        const IMPORTED: ImportedHash = {
            ...this.projectRc.IMPORTED,
            ...this.fileRc.IMPORTED,
        };

        return {
            ...DEFAULT_RC,
            ...this.globalRc,
            ...this.projectRc,
            ...this.fileRc,
            IMPORTED,
        };
    }

    public createSoundRc(): Rc {
        const IMPORTED: ImportedHash = {
            ...this.projectRc.IMPORTED,
            ...this.soundFileRc.IMPORTED,
        };

        return {
            ...DEFAULT_RC,
            ...this.globalRc,
            ...this.projectRc,
            ...this.soundFileRc,
            IMPORTED,
        };
    }

    public setGlobalSettings(rc: RcFragment): void {
        // _globalRc must be extended everytime,
        // because setGlobalSettings can be called for properties one by one.
        this.globalRc = { ...this.globalRc, ...rc };
        this.onChange();
    }

    public setProjectSettings(rc: RcFragment): void {
        this.projectRc = rc;
        this.onChange();
    }

    public setFileSettings(filepath: string, rc: RcFragment): RcDiff {
        rc = fixPath(path.dirname(filepath), rc);

        this.fileRc = rc;
        const newRc = this.createRc();
        const diff = this.getDiff(this.rc, newRc);
        this.rc = newRc;
        return diff;
    }

    public setSoundSettings(filepath: string, rc: RcFragment): RcDiff {
        rc = fixPath(path.dirname(filepath), rc);

        this.soundFileRc = rc;
        const newRc = this.createSoundRc();
        const diff = this.getDiff(this.soundRc, newRc);
        this.soundRc = newRc;
        return diff;
    }

    private parseComment(comment: string): RcFragment {
        let rc: RcFragment = {};
        try {
            rc = JSON5.parse(comment);
        } catch (e) {
            console.error('Failed to parse comment:', e);
        }

        return rc;
    }

    public setFileSettingsByString(filepath: string, comment: string): RcDiff {
        return this.setFileSettings(filepath, this.parseComment(comment));
    }

    public setSoundSettingsByString(filepath: string, comment: string): RcDiff {
        return this.setSoundSettings(filepath, this.parseComment(comment));
    }

    private onChange = throttle((): void => {
        const newRc = this.createRc();
        this.emit('change', this.getDiff(this.rc, newRc));
        this.rc = newRc;
    }, 100);

    private getDiff(oldObj: Rc, newObj: Rc): RcDiff {
        const diff: RcDiff = {
            newConfig: newObj,
            added: { IMPORTED: {} },
            removed: { IMPORTED: {} },
        };

        // Get diffs of IMPORTED
        const newIMPORTED = newObj.IMPORTED;
        const oldIMPORTED = oldObj.IMPORTED;

        Object.keys(newIMPORTED).forEach((key): void => {
            const newImport = newIMPORTED[key] || {};
            const oldImport = oldIMPORTED[key] || {};
            if (
                oldImport.PATH &&
                (newImport.PATH !== oldImport.PATH ||
                    newImport.SPEED !== oldImport.SPEED)
            ) {
                diff.removed.IMPORTED[key] = oldImport;
            }
            if (
                newImport.PATH &&
                (newImport.PATH !== oldImport.PATH ||
                    newImport.SPEED !== oldImport.SPEED)
            ) {
                diff.added.IMPORTED[key] = newImport;
            }
        });

        // Get updated properties
        if (newObj.pixelRatio !== oldObj.pixelRatio) {
            diff.added.pixelRatio = newObj.pixelRatio;
        }
        if (newObj.frameskip !== oldObj.frameskip) {
            diff.added.frameskip = newObj.frameskip;
        }
        if (newObj.vertexMode !== oldObj.vertexMode) {
            diff.added.vertexMode = newObj.vertexMode;
        }
        if (newObj.vertexCount !== oldObj.vertexCount) {
            diff.added.vertexCount = newObj.vertexCount;
        }
        if (newObj.glslangValidatorPath !== oldObj.glslangValidatorPath) {
            diff.added.glslangValidatorPath = newObj.glslangValidatorPath;
        }
        if (newObj.fftSize !== oldObj.fftSize) {
            diff.added.fftSize = newObj.fftSize;
        }
        if (
            newObj.fftSmoothingTimeConstant !== oldObj.fftSmoothingTimeConstant
        ) {
            diff.added.fftSmoothingTimeConstant =
                newObj.fftSmoothingTimeConstant;
        }

        if (newObj.audio !== oldObj.audio) {
            diff.added.audio = newObj.audio;
        }
        if (newObj.camera !== oldObj.camera) {
            diff.added.camera = newObj.camera;
        }
        if (newObj.gamepad !== oldObj.gamepad) {
            diff.added.gamepad = newObj.gamepad;
        }
        if (newObj.midi !== oldObj.midi) {
            diff.added.midi = newObj.midi;
        }
        if (newObj.keyboard !== oldObj.keyboard) {
            diff.added.keyboard = newObj.keyboard;
        }

        if (newObj.server !== oldObj.server) {
            diff.added.server = newObj.server;
        }
        if (newObj.osc !== oldObj.osc) {
            diff.added.osc = newObj.osc;
        }
        if (newObj.soundLength !== oldObj.soundLength) {
            diff.added.soundLength = newObj.soundLength;
        }

        return diff;
    }
}
