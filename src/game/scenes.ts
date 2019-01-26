import * as THREE from 'three';
import {
    map,
    filter,
    each,
    noop
} from 'lodash';

import islandSceneMapping from '../island/data/sceneMapping';
import {loadIslandScenery, getEnvInfo} from '../island';
import {loadIsometricScenery} from '../iso';
import {loadSceneData} from '../scene';
import {loadSceneMapData} from '../scene/map';
import {loadActor} from './actors';
import {loadPoint} from './points';
import {loadZone} from './zones';
import {loadScripts, killActor, reviveActor} from '../scripting';
import {initCameraMovement} from './loop/cameras';
import DebugData, * as DBG from '../ui/editor/DebugData';
import {sBind} from '../utils';

declare global {
    var ga: Function;
}

const {initSceneDebugData, loadSceneMetaData} = DBG;

export async function createSceneManager(params, game, renderer, hideMenu: Function) {
    let scene = null;
    let sceneMap = null;
    const sceneManager = {
        /* @inspector(locate, pure) */
        getScene() {
            return scene;
        },

        /* @inspector(locate) */
        hideMenuAndGoto(index, wasPaused) {
            hideMenu(wasPaused);
            return this.goto(index, false, wasPaused);
        },

        /* @inspector(locate) */
        async goto(index, force = false, wasPaused = false) {
            if ((!force && scene && index === scene.index) || game.isLoading())
                return;

            ga('set', 'page', `/scene/${index}`);
            ga('send', 'pageview');

            if (scene)
                scene.isActive = false;

            game.setUiState({ text: null, cinema: false });

            const hash = window.location.hash;
            if (hash.match(/scene=\d+/)) {
                window.location.hash = hash.replace(/scene=\d+/, `scene=${index}`);
            }

            const musicSource = game.getAudioManager().getMusicSource();
            const menuMusicSource = game.getAudioMenuManager().getMusicSource();
            if (scene && scene.sideScenes && index in scene.sideScenes) {
                killActor(scene.actors[0]);
                const sideScene = scene.sideScenes[index];
                sideScene.sideScenes = scene.sideScenes;
                delete sideScene.sideScenes[index];
                delete scene.sideScenes;
                sideScene.sideScenes[scene.index] = scene;
                scene = sideScene;
                reviveActor(scene.actors[0]); // Awake twinsen
                scene.isActive = true;
                if (!musicSource.isPlaying) {
                    musicSource.load(scene.data.ambience.musicIndex, () => {
                        menuMusicSource.stop(); // if menu music is start playing during load
                        musicSource.play();
                    });
                }
                initSceneDebugData();
                return scene;
            }
            game.loading(index);
            scene = await loadScene(
                this,
                params,
                game,
                renderer,
                sceneMap,
                index,
                null
            );
            renderer.applySceneryProps(scene.scenery.props);
            scene.isActive = true;
            if (!musicSource.isPlaying) {
                musicSource.load(scene.data.ambience.musicIndex, () => {
                    // if menu music has started playing during load
                    menuMusicSource.stop();
                    musicSource.play();
                });
            }
            initSceneDebugData();
            scene.sceneNode.updateMatrixWorld();
            initCameraMovement(game.controlsState, renderer, scene);
            game.loaded(wasPaused);
            return scene;
        },

        /* @inspector(locate) */
        async next() {
            if (scene) {
                const nextIdx = (scene.index + 1) % sceneMap.length;
                return this.goto(nextIdx);
            }
        },

        /* @inspector(locate) */
        async previous() {
            if (scene) {
                const previousIdx = scene.index > 0 ? scene.index - 1 : sceneMap.length - 1;
                return this.goto(previousIdx);
            }
        }
    };

    sceneMap = await loadSceneMapData();

    return sceneManager;
}

async function loadScene(sceneManager, params, game, renderer, sceneMap, index, parent) {
    const sceneData = await loadSceneData(game.getState().config.language, index);
    if (params.editor) {
        await loadSceneMetaData(index);
    }
    const indexInfo = sceneMap[index];
    let islandName;
    if (indexInfo.isIsland) {
        islandName = islandSceneMapping[index].island;
        if (game.getState().flags.quest[152] && islandName === 'CITABAU') {
            islandName = 'CITADEL';
        }
    }
    const envInfo = indexInfo.isIsland ? getEnvInfo(islandName) : {
        skyColor: [0, 0, 0],
        fogDensity: 0,
    };
    const actors = await Promise.all(map(
        sceneData.actors,
        actor => loadActor(params, envInfo, sceneData.ambience, actor)
    ));
    const points = map(sceneData.points, loadPoint);
    const zones = map(sceneData.zones, loadZone);

    let scenery = null;
    let threeScene = null;
    if (!parent) {
        threeScene = new THREE.Scene();
        if (indexInfo.isIsland) {
            scenery = await loadIslandScenery(params, islandName, sceneData.ambience);
            threeScene.name = '3D_scene';
        } else {
            scenery = await loadIsometricScenery(renderer, indexInfo.index);
            threeScene.name = 'iso_scene';
        }

        threeScene.add(scenery.threeObject);
    } else {
        scenery = parent.scenery;
        threeScene = parent.threeScene;
    }

    const sceneNode = loadSceneNode(index, indexInfo, scenery, actors, zones, points);
    threeScene.add(sceneNode);
    const scene = {
        index,
        data: sceneData,
        isIsland: indexInfo.isIsland,
        threeScene,
        sceneNode,
        scenery,
        parentScene: parent,
        sideScenes: null,
        actors,
        points,
        zones,
        extras: [],
        isActive: false,
        variables: null,
        section: null,
        usedVarGames: null,
        zoneState: { listener: null, ended: false },
        goto: sBind(sceneManager.goto, sceneManager),

        /* @inspector(locate) */
        reset() {
            each(this.actors, (actor) => {
                actor.reset();
            });
            loadScripts(params, game, scene);
            initCameraMovement(game.controlsState, renderer, scene);
            if (game.isPaused()) {
                DebugData.step = true;
            }
            scene.variables = createSceneVariables(scene);
        },

        /* @inspector(locate) */
        removeMesh(threeObject) {
            this.threeScene.remove(threeObject);
        },

        /* @inspector(locate) */
        addMesh(threeObject) {
            this.threeScene.add(threeObject);
        }
    };
    if (scene.isIsland) {
        scene.section = islandSceneMapping[index].section;
        if (!parent) {
            scene.sideScenes = await loadSideScenes(
                sceneManager,
                params,
                game,
                renderer,
                sceneMap,
                index,
                scene
            );
        }
    }
    loadScripts(params, game, scene);
    scene.variables = createSceneVariables(scene);
    scene.usedVarGames = findUsedVarGames(scene);
    // Kill twinsen if side scene
    if (parent) {
        killActor(scene.actors[0]);
    }
    return scene;
}

function loadSceneNode(index, indexInfo, scenery, actors, zones, points) {
    const sceneNode = indexInfo.isIsland ? new THREE.Object3D() : new THREE.Scene();
    sceneNode.name = `scene_${index}`;
    if (indexInfo.isIsland) {
        const sectionIdx = islandSceneMapping[index].section;
        const section = scenery.sections[sectionIdx];
        sceneNode.position.x = section.x * 2;
        sceneNode.position.z = section.z * 2;
    }
    const addToSceneNode = (obj) => {
        if (obj.threeObject !== null) { // because of the sprite actors
            sceneNode.add(obj.threeObject);
        }
    };

    each(actors, addToSceneNode);
    each(zones, addToSceneNode);
    each(points, addToSceneNode);
    return sceneNode;
}

async function loadSideScenes(sceneManager,
                                params,
                                game,
                                renderer,
                                sceneMap,
                                index,
                                parent) {
    const sideIndices = filter(
        map(sceneMap, (indexInfo, sideIndex) => {
            if (sideIndex !== index
                && indexInfo.isIsland
                && sideIndex in islandSceneMapping) {
                const sideMapping = islandSceneMapping[sideIndex];
                const mainMapping = islandSceneMapping[index];
                if (sideMapping.island === mainMapping.island
                    && sideMapping.variant === mainMapping.variant) {
                    return sideIndex;
                }
            }
            return null;
        }),
        id => id !== null
    );

    const sideScenes = await Promise.all(map(
        sideIndices,
        async sideIndex => loadScene(
            sceneManager,
            params,
            game,
            renderer,
            sceneMap,
            sideIndex,
            parent
        )
    ));
    const sideScenesMap = {};
    each(sideScenes, (sideScene: any) => {
        sideScenesMap[sideScene.index] = sideScene;
    });
    return sideScenesMap;
}

function createSceneVariables(scene) {
    let maxVarCubeIndex = -1;
    each(scene.actors, (actor) => {
        const commands = actor.scripts.life.commands;
        each(commands, (cmd) => {
            if (cmd.op.command === 'SET_VAR_CUBE') {
                maxVarCubeIndex = Math.max(cmd.args[0].value, maxVarCubeIndex);
            }
            if (cmd.condition && cmd.condition.op.command === 'VAR_CUBE') {
                maxVarCubeIndex = Math.max(cmd.condition.param.value, maxVarCubeIndex);
            }
        });
    });
    const variables = [];
    for (let i = 0; i <= maxVarCubeIndex; i += 1) {
        variables.push(0);
    }
    return variables;
}

function findUsedVarGames(scene) {
    const usedVars = [];
    each(scene.actors, (actor) => {
        const commands = actor.scripts.life.commands;
        each(commands, (cmd) => {
            let value = null;
            if (cmd.op.command === 'SET_VAR_GAME') {
                value = cmd.args[0].value;
            } else if (cmd.condition && cmd.condition.op.command === 'VAR_GAME') {
                value = cmd.condition.param.value;
            }
            if (value !== null && usedVars.indexOf(value) === -1) {
                usedVars.push(value);
            }
        });
    });
    usedVars.sort((a, b) => a - b);
    return usedVars;
}
