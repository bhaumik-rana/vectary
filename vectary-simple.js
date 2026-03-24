// Simplified Vectary configurator integration for Magento 2
// Based on vectary-simple.js - clean, efficient implementation
// Removed all hardcoded values - everything comes from config/mapping
(function (root, factory) {
    'use strict';

    if (typeof define === 'function' && define.amd) {
        define(['jquery'], factory);
        return;
    }

    // Non-AMD fallback (plain script include)
    var initFn = factory(root.jQuery || root.$);
    root.vectaryDynamicInit = initFn;

    // Auto-run when config is already available on window
    if (root.vectaryConfig) {
        try {
            var fallbackElement = root.document.querySelector('[data-vectary-type="configurator"], .vectary-configurator-wrapper');
            initFn(root.vectaryConfig, fallbackElement);
        } catch (e) {
            console.error('[Vectary] Failed to auto initialize in non-AMD mode', e);
        }
    }
}(window, function ($) {
    'use strict';

    return function (config, element) {
        // Only initialize if this is a configurator model
        var isConfigurator = config.isConfigurator === true;
        var elementType = element ? element.getAttribute('data-vectary-type') : null;
        var isConfiguratorElement = elementType === 'configurator' ||
            (element && element.classList.contains('vectary-configurator-wrapper'));

        if (!isConfigurator && !isConfiguratorElement) {
            console.log('[Vectary] Skipping initialization - not a configurator model');
            return;
        }

        var iframeId = config.iframeId || 'vectary-configurator-embed';
        var materialsCsvUrl = config.materialsCsvUrl || '';
        var mapping = config.mapping || {};
        var debug = config.debug !== undefined ? config.debug : true; // Enable debug by default for troubleshooting

        // Log mapping structure for debugging (only if debug is enabled)
        if (debug) {
            console.log('[Vectary] Initializing with config:', {
                iframeId: iframeId,
                hasMapping: !!mapping,
                mappingKeys: mapping ? Object.keys(mapping) : [],
                mapping: mapping
            });
        }

        // ============================================================================
        // STATE MANAGEMENT
        // ============================================================================

        var modelApi = null;
        var fileCache = new Map();
        var objectCache = new Map();
        var activeMaterialObjects = new Map();
        var debounceTimer = null;
        var currentFabricSelection = null; // Track current fabric selection for armrest
        var currentArmrestSelection = null; // Track current armrest selection

        // ============================================================================
        // UTILITY FUNCTIONS
        // ============================================================================

        function debugLog(...args) {
            if (debug) {
                console.log('[Vectary]', ...args);
            }
        }

        function debounce(func, delay) {
            return function (...args) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => func.apply(this, args), delay);
            };
        }

        function normalizeString(str) {
            return (str || '').toString().toLowerCase().replace(/[_\s]/g, '');
        }

        function getObjectId(obj) {
            return obj && (obj.id || obj.uuid || obj.objectId || obj.instanceId);
        }

        // ============================================================================
        // CSV PARSING
        // ============================================================================

        function parseCsv(text) {
            const rows = [];
            let current = [];
            let value = '';
            let inQuotes = false;

            function endValue() {
                current.push(value);
                value = '';
            }

            function endRow() {
                if (inQuotes) return;
                endValue();
                if (current.length && current.some(v => v !== '')) {
                    rows.push(current);
                }
                current = [];
            }

            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                const next = text[i + 1];

                if (ch === '"') {
                    if (inQuotes && next === '"') {
                        value += '"';
                        i++;
                    } else {
                        inQuotes = !inQuotes;
                    }
                } else if (ch === ',' && !inQuotes) {
                    endValue();
                } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
                    if (ch === '\r' && next === '\n') {
                        i++;
                    }
                    endRow();
                } else {
                    value += ch;
                }
            }

            if (value.length || current.length) {
                endValue();
                if (current.length && current.some(v => v !== '')) {
                    rows.push(current);
                }
            }

            if (!rows.length) return [];
            const headers = rows[0].map(h => h.trim());
            const dataRows = rows.slice(1);
            return dataRows.map(cols => {
                const obj = {};
                headers.forEach((h, idx) => {
                    obj[h] = (cols[idx] || '').trim();
                });
                return obj;
            });
        }

        async function loadMaterialsCsv(url) {
            if (!url) {
                debugLog('No materials CSV URL provided');
                return { rows: [], byName: new Map(), byNameLower: new Map() };
            }

            if (window.location.protocol === 'file:') {
                throw new Error(
                    'This page is opened with file:// and browser security blocks CSV fetch. ' +
                    'Run from a local server (for example: `cd /home/sneha.solanki@brainvire.com/Documents/applied/Freedom_26 && python3 -m http.server 8080`) ' +
                    'and open http://localhost:8080'
                );
            }

            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) {
                throw new Error(`Failed to load materials CSV: ${res.status} ${res.statusText}`);
            }
            const text = await res.text();
            const rows = parseCsv(text);
            const byName = new Map();
            const byNameLower = new Map(); // Case-insensitive lookup
            rows.forEach(row => {
                if (row.name) {
                    byName.set(row.name, row);
                    // Also store with lowercase key for case-insensitive lookup
                    byNameLower.set(row.name.toLowerCase(), row);
                }
            });
            return { rows, byName, byNameLower };
        }

        // ============================================================================
        // VECTARY API INITIALIZATION
        // ============================================================================

        async function initVectaryApi(iframeId) {
            let modelApi;
            let initPromise;

            if (window.VctrModelApi) {
                debugLog('Using existing window.VctrModelApi');
                modelApi = new window.VctrModelApi(iframeId);
                initPromise = modelApi.init();
            } else {
                debugLog('Importing Vectary API module');
                initPromise = import('https://www.vectary.com/studio-lite/scripts/api.js')
                    .then(mod => {
                        const Api = mod && (mod.VctrModelApi || (mod.default && mod.default.VctrModelApi));
                        if (!Api) {
                            throw new Error('Failed to obtain VctrModelApi from Vectary module');
                        }
                        modelApi = new Api(iframeId);
                        return modelApi.init();
                    });
            }

            await initPromise;
            debugLog('Vectary API initialized');
            return modelApi;
        }

        // ============================================================================
        // OBJECT MANAGEMENT
        // ============================================================================

        function flattenObjectsRecursively(objects, flat) {
            const list = flat || [];
            (objects || []).forEach(obj => {
                if (!obj) return;
                list.push(obj);
                if (Array.isArray(obj.children) && obj.children.length) {
                    flattenObjectsRecursively(obj.children, list);
                }
            });
            return list;
        }

        function buildObjectIndex(objects) {
            const flatObjects = flattenObjectsRecursively(objects || []);
            const byName = new Map();
            flatObjects.forEach(obj => {
                const name = (obj && obj.name) || '';
                if (!name) return;
                const list = byName.get(name) || [];
                list.push(obj);
                byName.set(name, list);
            });
            return byName;
        }

        async function hideObjects(modelApi, objectIds) {
            if (!objectIds || !objectIds.length) return;
            try {
                await modelApi.toggleVisibility(objectIds, false);
            } catch (err) {
                debugLog('Error hiding objects:', err);
            }
        }

        async function showObjects(modelApi, objectIds) {
            if (!objectIds || !objectIds.length) return;
            try {
                await modelApi.toggleVisibility(objectIds, true);
            } catch (err) {
                debugLog('Error showing objects:', err);
            }
        }

        // ============================================================================
        // MATERIAL MATCHING
        // ============================================================================

        function findMatchingMaterial(importedObject, targetName, targetColor) {
            if (!importedObject || !importedObject.materials || !importedObject.materials.length) {
                return null;
            }

            const materials = importedObject.materials;
            const targetNorm = normalizeString(targetName);

            // Tier 1: Exact name match
            let match = materials.find(m => m.name === targetName);
            if (match) return match;

            // Tier 2: Normalized match
            match = materials.find(m => normalizeString(m.name) === targetNorm);
            if (match) return match;

            // Tier 3: Partial match
            match = materials.find(m => {
                const n = (m.name || '').toLowerCase();
                const t = (targetName || '').toLowerCase();
                return n.endsWith(t) || n.includes(t) || t.includes(n);
            });
            if (match) return match;

            // Tier 4: Color property match
            if (targetColor) {
                const colorLower = normalizeString(targetColor);
                match = materials.find(m => {
                    const mc = normalizeString(m.color);
                    return mc === colorLower;
                });
                if (match) return match;
            }

            // Tier 5: Short token match
            if (targetColor && targetColor.includes('_')) {
                const shortToken = targetColor.split('_').pop().toLowerCase();
                match = materials.find(m => {
                    const n = (m.name || '').toLowerCase();
                    return n.includes(shortToken);
                });
                if (match) return match;
            }

            return null;
        }

        // ============================================================================
        // 3D FILE LOADING (WITH CACHING)
        // ============================================================================

        async function loadMaterialObject(modelApi, csvRow) {
            const fileUrlFromDb = csvRow.download_link || csvRow._3d_file || '';
            if (!fileUrlFromDb) {
                throw new Error(`No download_link or _3d_file specified for material: ${csvRow.name || ''}`);
            }

            let fileUrl = fileUrlFromDb;
            if (!fileUrl.includes('://') && !fileUrl.startsWith('./')) {
                fileUrl = './vectary/3d_files/' + fileUrl;
            }

            // Check cache first
            if (objectCache.has(fileUrl)) {
                debugLog('Using cached object for material', csvRow.name);
                return objectCache.get(fileUrl);
            }

            debugLog('Loading 3D file for material', csvRow.name, 'from', fileUrl);

            // Get objects before import
            const beforeObjects = await modelApi.getObjects();
            const beforeIds = new Set(beforeObjects.map(getObjectId).filter(Boolean));

            // Fetch file (check cache first)
            let blob;
            if (fileCache.has(fileUrl)) {
                debugLog('Using cached file blob for', fileUrl);
                blob = fileCache.get(fileUrl);
            } else {
                const res = await fetch(fileUrl);
                if (!res.ok) {
                    throw new Error(`Failed to fetch 3D file: ${fileUrl} (${res.status} ${res.statusText})`);
                }
                blob = await res.blob();
                fileCache.set(fileUrl, blob);
            }

            // Create file object
            const filename = csvRow._3d_file || (csvRow.name ? `${csvRow.name}.vctr3` : 'material.vctr3');
            const file = new File([blob], filename, { type: blob.type || 'model/vctr3' });

            // Import into Vectary
            await modelApi.importFiles(file, 2);

            // Find the newly imported object
            const afterObjects = await modelApi.getObjects();
            const imported = afterObjects.find(o => {
                const id = getObjectId(o);
                return id && !beforeIds.has(id);
            });

            if (!imported) {
                throw new Error(`Imported object not found after importing file: ${fileUrl}`);
            }

            // Cache the imported object
            objectCache.set(fileUrl, imported);
            debugLog('Imported and cached object for material', csvRow.name);

            return imported;
        }

        // ============================================================================
        // MATERIAL APPLICATION
        // ============================================================================

        async function applyMaterial(modelApi, mapping, objectIndex, applicationName, optionLabel, materialsData) {
            // Validate applicationName exists in mapping
            if (!applicationName) {
                throw new Error(`Application name is required but was not provided`);
            }

            // Validate that applicationName exists in mapping.applications values
            const validApplicationNames = Object.values(mapping.applications || {});
            if (!validApplicationNames.includes(applicationName)) {
                console.warn('[Vectary] Warning: applicationName', applicationName, 'not found in mapping.applications. Available:', validApplicationNames);
            }

            const appMaterials = (mapping.materials && mapping.materials[applicationName]) || null;
            if (!appMaterials) {
                throw new Error(`No materials mapping found for application: ${applicationName}`);
            }

            const materialMapping = appMaterials[optionLabel];
            if (!materialMapping) {
                throw new Error(`No material mapping found for option "${optionLabel}" in application "${applicationName}"`);
            }

            const csvName = materialMapping.name;
            const csvColor = materialMapping.color;
            
            debugLog('Applying material:', { applicationName, optionLabel, csvName, csvColor });
            debugLog('Materials data available:', materialsData ? 'Yes' : 'No');
            debugLog('Materials byName map size:', materialsData?.byName?.size || 0);
            
            if (!materialsData || !materialsData.byName) {
                throw new Error(`Materials data not loaded. Please check if the CSV file exists.`);
            }

            // Try exact match first
            let csvRow = materialsData.byName.get(csvName);

            if (!csvRow) {
                // Try case-insensitive search
                let foundRow = null;
                for (const [name, row] of materialsData.byName.entries()) {
                    if (name.toLowerCase() === csvName.toLowerCase()) {
                        foundRow = row;
                        debugLog('Found material with case-insensitive match:', name);
                        break;
                    }
                }

                if (!foundRow && materialsData.byNameLower) {
                    foundRow = materialsData.byNameLower.get(csvName.toLowerCase());
                }

                if (!foundRow) {
                    // List available materials for debugging
                    const availableMaterials = Array.from(materialsData.byName.keys()).slice(0, 10);
                    debugLog('Available materials (first 10):', availableMaterials);
                    throw new Error(`Material name "${csvName}" not found in materials CSV. Available materials include: ${availableMaterials.join(', ')}...`);
                }
                // Use the found row
                csvRow = foundRow;
            }

            // Hide previous material objects for this application
            const previousObjects = activeMaterialObjects.get(applicationName);
            if (previousObjects && previousObjects.length) {
                const previousIds = previousObjects.map(getObjectId).filter(Boolean);
                await hideObjects(modelApi, previousIds);
                debugLog('Hid previous material objects for', applicationName);
            }

            // Load the material object (cached if already loaded)
            const importedObject = await loadMaterialObject(modelApi, csvRow);

            // Find matching material
            let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
            if (!matchedMaterial) {
                if (importedObject.materials && importedObject.materials.length) {
                    matchedMaterial = importedObject.materials[0];
                    debugLog('No exact material match found, falling back to first material:', matchedMaterial);
                } else {
                    throw new Error(`No matching material found in imported object for "${csvName}" (${csvColor || ''})`);
                }
            }

            // Get target object names from mapping (no hardcoded values)
            const targetObjectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];
            if (!targetObjectNames.length) {
                throw new Error(`No target object names defined for application "${applicationName}". Available applications: ${Object.keys(mapping.objectNames || {}).join(', ')}`);
            }

            debugLog('Target object names for', applicationName, ':', targetObjectNames);
            debugLog('Available objects in index:', Array.from(objectIndex.keys()).slice(0, 20));

            // Validate that we're only applying to objects specific to this application
            const allowedObjectNames = new Set(targetObjectNames.map(name => name.toLowerCase()));

            // Log validation info
            debugLog('Validating material application - Application:', applicationName, 'will only apply to objects:', Array.from(allowedObjectNames));

            // Define plastic parts objects that should never be overwritten by other applications
            const plasticPartsObjects = (mapping.objectNames && mapping.objectNames['plastic_parts']) || [];
            const plasticPartsSet = new Set(plasticPartsObjects.map(name => name.toLowerCase()));

            // Apply material to all target objects
            let appliedCount = 0;
            const defaultMaterial = importedObject && importedObject.materials && importedObject.materials.length
                ? importedObject.materials[0]
                : matchedMaterial;

            for (const name of targetObjectNames) {
                // Validate that this object name is allowed for this application
                if (!allowedObjectNames.has(name.toLowerCase())) {
                    console.warn(`[Vectary] Skipping object "${name}" - not in allowed list for application "${applicationName}"`);
                    debugLog(`Skipping object "${name}" - not in allowed list for application "${applicationName}"`);
                    continue;
                }

                // Skip if this is a plastic parts object and we're not applying plastic parts material
                if (applicationName !== 'plastic_parts' && plasticPartsSet.has(name.toLowerCase())) {
                    debugLog(`Skipping plastic parts object "${name}" for application "${applicationName}"`);
                    continue;
                }

                const objs = objectIndex.get(name) || [];
                debugLog(`Found ${objs.length} objects for name "${name}" (application: ${applicationName})`);

                if (objs.length === 0) {
                    debugLog(`Warning: No objects found for name "${name}". Available object names:`, Array.from(objectIndex.keys()).filter(n => n.toLowerCase().includes(name.toLowerCase())));
                }

                for (const obj of objs) {
                    const id = getObjectId(obj);
                    if (!id) {
                        debugLog('Object has no ID:', obj);
                        continue;
                    }

                    try {
                        await modelApi.addOrEditMaterial(id, matchedMaterial);
                        appliedCount++;
                        debugLog(`Successfully applied material to object ${id} (name: ${name}, application: ${applicationName})`);
                    } catch (e) {
                        debugLog('addOrEditMaterial failed for id', id, 'with matched material, trying default', e);
                        if (defaultMaterial && defaultMaterial !== matchedMaterial) {
                            try {
                                await modelApi.addOrEditMaterial(id, defaultMaterial);
                                appliedCount++;
                                debugLog('Successfully applied default material to object', id);
                            } catch (e2) {
                                console.error('Failed to apply both matched and default material for object', id, e2);
                                debugLog('Failed to apply both materials to object', id, e2);
                            }
                        }
                    }
                }
            }

            if (!appliedCount) {
                const availableNames = Array.from(objectIndex.keys());
                throw new Error(`Failed to apply material for application "${applicationName}". No objects found or material application failed. Target names: ${targetObjectNames.join(', ')}. Available object names (first 20): ${availableNames.slice(0, 20).join(', ')}`);
            }

            // Store active objects for this application
            activeMaterialObjects.set(applicationName, [importedObject]);

            debugLog('Applied material', matchedMaterial, 'to', appliedCount, 'objects for application', applicationName);

            // If fabric_seat was applied, check if armrest is set to "Fabric Armrest" and update it
            if (applicationName === 'fabric_seat') {
                // Check if armrest is currently set to "Fabric Armrest"
                if (currentArmrestSelection === 'Fabric Armrest') {
                    debugLog('Fabric was changed and armrest is set to Fabric Armrest, updating armrest with new fabric');
                    // Apply the fabric material to fabric_armrest objects
                    const fabricArmrestObjects = objectIndex.get('fabric_armrest') || [];
                    if (fabricArmrestObjects.length > 0) {
                        for (const obj of fabricArmrestObjects) {
                            const id = getObjectId(obj);
                            if (id) {
                                try {
                                    await modelApi.addOrEditMaterial(id, matchedMaterial);
                                    debugLog('Updated armrest with new fabric material', id);
                                } catch (e) {
                                    debugLog('Failed to update armrest with fabric material', id, e);
                                }
                            }
                        }
                    }
                }
            }
        }

        // ============================================================================
        // HELPER: FIND OBJECTS BY NAME (FLEXIBLE MATCHING)
        // ============================================================================

        function findObjectsByName(objectIndex, targetName) {
            const found = [];
            const targetLower = targetName.toLowerCase();
            const targetNormalized = targetLower.replace(/[_\s-]/g, '');

            // Keywords to match
            const isWheel = targetNormalized.includes('wheel');
            const isGlide = targetNormalized.includes('glide');

            for (const [objName, objs] of objectIndex.entries()) {
                const objNameLower = objName.toLowerCase();
                const objNameNormalized = objNameLower.replace(/[_\s-]/g, '');

                // Exact match (normalized)
                if (objNameNormalized === targetNormalized) {
                    found.push(...objs);
                    continue;
                }

                // Exact match (case-insensitive)
                if (objNameLower === targetLower) {
                    found.push(...objs);
                    continue;
                }

                // Contains match for wheels
                if (isWheel && (objNameNormalized.includes('wheel') || objNameLower.includes('wheel'))) {
                    found.push(...objs);
                    continue;
                }

                // Contains match for glides
                if (isGlide && (objNameNormalized.includes('glide') || objNameLower.includes('glide'))) {
                    found.push(...objs);
                    continue;
                }

                // Partial match (one contains the other)
                if (objNameNormalized.includes(targetNormalized) || targetNormalized.includes(objNameNormalized)) {
                    found.push(...objs);
                }
            }

            return found;
        }

        // ============================================================================
        // BASE OPTIONS APPLICATION (SHOW/HIDE OBJECTS)
        // ============================================================================

        async function applyBaseOptions(modelApi, mapping, objectIndex, applicationName, optionLabel, materialsData) {
            try {
                const targetObjectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];
                
                if (!targetObjectNames.length) {
                    throw new Error(`No object names defined for application "${applicationName}" in mapping.`);
                }

                // Map option labels to object names to show
                const optionToObjectMap = {
                    "Wheels (Hard Floors)": "plastic_wheels",
                    "Glides (Soft/Carpet Floors)": "glides",
                    "Locking Castors": "plastic_wheels"
                };

                const objectToShow = optionToObjectMap[optionLabel];
                if (!objectToShow) {
                    throw new Error(`No object mapping found for option "${optionLabel}" in application "${applicationName}"`);
                }

                debugLog('Applying base option:', optionLabel, '-> showing object:', objectToShow);
                debugLog('Available objects in index:', Array.from(objectIndex.keys()));

                // Find all objects related to wheels and glides (including variations)
                const wheelsObjects = findObjectsByName(objectIndex, "plastic_wheels");
                const glidesObjects = findObjectsByName(objectIndex, "glides");

                // Also check exact names and common variations
                const exactWheels = objectIndex.get("plastic_wheels") || [];
                const exactGlides = objectIndex.get("glides") || [];

                // Check for additional glides variations
                const glidesVariations = [];
                for (const [objName, objs] of objectIndex.entries()) {
                    const nameLower = objName.toLowerCase();
                    if (nameLower.includes('glide') && !nameLower.includes('wheel')) {
                        glidesVariations.push(...objs);
                        debugLog('Found glides variation:', objName);
                    }
                }
                // Combine all found objects and deduplicate by object ID
                const wheelsMap = new Map();
                [...wheelsObjects, ...exactWheels].forEach(obj => {
                    const id = getObjectId(obj);
                    if (id && !wheelsMap.has(id)) {
                        wheelsMap.set(id, obj);
                    }
                });
                const allWheelsObjects = Array.from(wheelsMap.values());

                const glidesMap = new Map();
                [...glidesObjects, ...exactGlides, ...glidesVariations].forEach(obj => {
                    const id = getObjectId(obj);
                    if (id && !glidesMap.has(id)) {
                        glidesMap.set(id, obj);
                    }
                });
                const allGlidesObjects = Array.from(glidesMap.values());

                debugLog('Found wheels objects:', allWheelsObjects.length, 'Found glides objects:', allGlidesObjects.length);

                // First, ensure plastic_general (base structure) is visible
                const generalObjects = objectIndex.get("plastic_general") || [];
                const generalObjectIds = generalObjects.map(getObjectId).filter(Boolean);
                if (generalObjectIds.length) {
                    try {
                        await showObjects(modelApi, generalObjectIds);
                        debugLog('Ensured plastic_general base structure is visible first');
                    } catch (err) {
                        debugLog('Error showing plastic_general (non-critical):', err);
                    }
                }

                // Small delay to ensure base structure is shown
                await new Promise(resolve => setTimeout(resolve, 50));

                // Determine which objects to hide (only the OPPOSITE of what we're showing)
                let objectsToHide = [];
                let objectsToShow = [];

                if (objectToShow === "plastic_wheels") {
                    objectsToHide = allGlidesObjects;
                    objectsToShow = allWheelsObjects;
                    debugLog('Selected: Wheels - Will hide glides, show wheels');
                } else if (objectToShow === "glides") {
                    objectsToHide = allWheelsObjects;
                    objectsToShow = allGlidesObjects;
                    debugLog('Selected: Glides - Will hide wheels, show glides. Found', allGlidesObjects.length, 'glides objects');
                } else {
                    // Locking castors - same as wheels
                    objectsToHide = allGlidesObjects;
                    objectsToShow = allWheelsObjects;
                    debugLog('Selected: Locking Castors - Will hide glides, show wheels');
                }

                // Hide the opposite objects first
                const hideObjectIds = [];
                for (const obj of objectsToHide) {
                    const id = getObjectId(obj);
                    if (id) hideObjectIds.push(id);
                }

                if (hideObjectIds.length) {
                    try {
                        await hideObjects(modelApi, hideObjectIds);
                        debugLog('Hid opposite objects, count:', hideObjectIds.length);
                    } catch (err) {
                        debugLog('Error hiding objects (continuing anyway):', err);
                    }
                }

                // Small delay to ensure hide operation completes
                await new Promise(resolve => setTimeout(resolve, 50));

                // Now show the selected objects
                const showObjectIds = [];
                for (const obj of objectsToShow) {
                    const id = getObjectId(obj);
                    if (id) showObjectIds.push(id);
                }

                debugLog('Attempting to show', showObjectIds.length, 'objects for', objectToShow);

                if (showObjectIds.length > 0) {
                    try {
                        await showObjects(modelApi, showObjectIds);
                        debugLog('Successfully showed selected objects, count:', showObjectIds.length);
                    } catch (err) {
                        debugLog('Error showing objects:', err);
                        console.warn('Failed to show objects directly, trying alternatives...', err);
                    }
                }

                // Final verification: For glides, ensure they're actually visible
                if (objectToShow === "glides" && allGlidesObjects.length > 0) {
                    const finalGlideIds = allGlidesObjects.map(getObjectId).filter(Boolean);
                    if (finalGlideIds.length > 0) {
                        try {
                            await showObjects(modelApi, finalGlideIds);
                            debugLog('Final verification: Ensured glides are visible');
                        } catch (err) {
                            debugLog('Final verification failed (non-critical):', err);
                        }
                    }
                }

                // Apply black plastic material to the shown wheels/glides and plastic_general
                if (materialsData) {
                    await applyPlasticMaterialToObjects(modelApi, objectIndex, materialsData, [objectToShow, 'plastic_general'], mapping);
                }

            } catch (err) {
                debugLog('Error in applyBaseOptions:', err);
                throw err;
            }
        }

        // ============================================================================
        // HELPER: APPLY PLASTIC MATERIAL TO SPECIFIC OBJECTS
        // ============================================================================

        async function applyPlasticMaterialToObjects(modelApi, objectIndex, materialsData, objectNames, mapping) {
            try {
                // Get plastic parts material mapping
                const plasticPartsMaterials = (mapping.materials && mapping.materials['plastic_parts']) || null;
                if (!plasticPartsMaterials) {
                    return; // Silently return if no plastic parts mapping
                }

                const plasticMapping = plasticPartsMaterials['Black Plastic'] || 
                                      plasticPartsMaterials['General Plastic'] ||
                                      plasticPartsMaterials['Plastic Black'];
                
                if (!plasticMapping) {
                    return;
                }

                const csvName = plasticMapping.name;
                const csvColor = plasticMapping.color;

                if (!materialsData || !materialsData.byName) {
                    return;
                }

                // Find material in CSV
                let csvRow = materialsData.byName.get(csvName);
                if (!csvRow) {
                    for (const [name, row] of materialsData.byName.entries()) {
                        if (name.toLowerCase() === csvName.toLowerCase()) {
                            csvRow = row;
                            break;
                        }
                    }
                }

                if (!csvRow) {
                    return;
                }

                // Load the material object (will use cache if already loaded)
                const importedObject = await loadMaterialObject(modelApi, csvRow);

                // Find matching material
                let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
                if (!matchedMaterial && importedObject.materials && importedObject.materials.length) {
                    matchedMaterial = importedObject.materials[0];
                }

                if (!matchedMaterial) {
                    return;
                }

                // Apply to the specified objects
                const objectsToProcess = Array.isArray(objectNames) ? objectNames : [objectNames];
                
                for (const objName of objectsToProcess) {
                    let objs = objectIndex.get(objName) || [];
                    
                    // Try flexible matching for wheels/glides
                    if (objs.length === 0 && (objName === 'plastic_wheels' || objName === 'glides')) {
                        objs = findObjectsByName(objectIndex, objName);
                    }

                    for (const obj of objs) {
                        const id = getObjectId(obj);
                        if (!id) continue;

                        try {
                            await modelApi.addOrEditMaterial(id, matchedMaterial);
                            debugLog('Applied black plastic to', objName, 'object', id);
                        } catch (e) {
                            debugLog('Failed to apply plastic material to', objName, id, e);
                        }
                    }
                }
            } catch (err) {
                debugLog('Error applying plastic material to objects (non-critical):', err);
                // Don't throw - this is a non-critical operation
            }
        }

        // ============================================================================
        // VARIANT APPLICATION
        // ============================================================================

        async function applyVariant(modelApi, mapping, objectIndex, applicationName, optionLabel) {
            // Validate applicationName exists in mapping
            if (!applicationName) {
                throw new Error(`Application name is required but was not provided`);
            }

            const appMaterials = (mapping.materials && mapping.materials[applicationName]) || null;
            if (!appMaterials) {
                throw new Error(`No variant mapping found for application: ${applicationName}`);
            }

            const variantMapping = appMaterials[optionLabel];
            if (!variantMapping) {
                throw new Error(`No variant mapping found for option "${optionLabel}" in application "${applicationName}"`);
            }

            // The variant value should match the child object names in the switcher
            const variantValue = variantMapping.color || variantMapping.name || optionLabel;
            const targetObjectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];

            if (!targetObjectNames.length) {
                throw new Error(`No variant object names defined for application "${applicationName}" in mapping. Available applications: ${Object.keys(mapping.objectNames || {}).join(', ')}`);
            }

            debugLog('Applying variant for application:', applicationName, 'to objects:', targetObjectNames);

            // Read current configuration state
            const currentState = (await modelApi.getConfigurationState()) || [];
            const updatedState = Array.isArray(currentState) ? currentState.slice() : [];

            let matchedCount = 0;

            // Update variant configs
            updatedState.forEach(entry => {
                if (!entry) return;

                const variantName = entry.variant;
                if (variantName && targetObjectNames.includes(variantName)) {
                    entry.active_object = variantValue;
                    if (entry.active_object_instanceId) {
                        delete entry.active_object_instanceId;
                    }
                    matchedCount++;
                }
            });

            if (!matchedCount) {
                debugLog('No existing variant configs matched for application', applicationName, 'targetObjectNames', targetObjectNames, 'currentState', currentState);
                return;
            }

            debugLog('Applying variant', variantValue, 'for application', applicationName, 'on', matchedCount, 'config entries');
            await modelApi.setConfigurationState(updatedState);
        }

        // ============================================================================
        // ARMREST APPLICATION (SPECIAL HANDLING)
        // ============================================================================

        async function applyArmrest(modelApi, mapping, objectIndex, applicationName, optionLabel, materialsData) {
            // Validate applicationName exists in mapping
            if (!applicationName) {
                throw new Error(`Application name is required but was not provided`);
            }

            const appMaterials = (mapping.materials && mapping.materials[applicationName]) || null;
            if (!appMaterials) {
                throw new Error(`No armrest mapping found for application: ${applicationName}`);
            }

            const armrestMapping = appMaterials[optionLabel];
            if (!armrestMapping) {
                throw new Error(`No armrest mapping found for option "${optionLabel}" in application "${applicationName}"`);
            }

            const variantValue = armrestMapping.color || armrestMapping.name || optionLabel;
            const materialType = armrestMapping.material_type; // "fabric", "plastic", or undefined (for "Without Armrest")
            const targetObjectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];

            if (!targetObjectNames.length) {
                throw new Error(`No variant object names defined for application "${applicationName}" in mapping. Available applications: ${Object.keys(mapping.objectNames || {}).join(', ')}`);
            }

            debugLog('Applying armrest for application:', applicationName, 'to objects:', targetObjectNames);

            // First, set the variant state (armrest on/off)
            const currentState = (await modelApi.getConfigurationState()) || [];
            const updatedState = Array.isArray(currentState) ? currentState.slice() : [];

            let matchedCount = 0;
            updatedState.forEach(entry => {
                if (!entry) return;
                const variantName = entry.variant;
                if (variantName && targetObjectNames.includes(variantName)) {
                    entry.active_object = variantValue;
                    if (entry.active_object_instanceId) {
                        delete entry.active_object_instanceId;
                    }
                    matchedCount++;
                }
            });

            if (matchedCount > 0) {
                debugLog('Applying armrest variant', variantValue, 'for application', applicationName);
                await modelApi.setConfigurationState(updatedState);
            }

            // If armrest is off, we're done
            if (variantValue === 'armrest off' || !materialType) {
                debugLog('Armrest set to off, no material application needed');
                return;
            }

            // If armrest is on, apply the appropriate material
            const fabricArmrestObjects = objectIndex.get('fabric_armrest') || [];
            if (fabricArmrestObjects.length === 0) {
                debugLog('No fabric_armrest objects found, skipping material application');
                return;
            }

            if (materialType === 'fabric') {
                // Auto-selected fabric is used when user switches from plastic to fabric armrest
                const fabricFromUi = getCurrentAttributeValue('Fabric Options');
                if (fabricFromUi) {
                    currentFabricSelection = fabricFromUi;
                    debugLog('Resolved fabric selection from UI for armrest:', fabricFromUi);
                }

                if (!currentFabricSelection) {
                    debugLog('No fabric selection found, cannot apply fabric to armrest');
                }

                if (currentFabricSelection) {
                    const fabricMaterials = (mapping.materials && mapping.materials['fabric_seat']) || null;
                    let fabricMapping = fabricMaterials && fabricMaterials[currentFabricSelection];
                    // If no exact match, try to find a mapping key that matches (e.g. label normalization)
                    if (!fabricMapping && fabricMaterials) {
                        const normalized = currentFabricSelection.trim().toLowerCase();
                        for (const key of Object.keys(fabricMaterials)) {
                            if (key.trim().toLowerCase() === normalized) {
                                fabricMapping = fabricMaterials[key];
                                debugLog('Matched fabric by normalized key:', key);
                                break;
                            }
                        }
                    }
                    if (fabricMapping) {
                        const csvName = fabricMapping.name;
                        const csvColor = fabricMapping.color;

                        debugLog('Applying fabric material to armrest:', { csvName, csvColor });

                        if (materialsData && materialsData.byName) {
                            let csvRow = materialsData.byName.get(csvName);
                            if (!csvRow) {
                                for (const [name, row] of materialsData.byName.entries()) {
                                    if (name.toLowerCase() === csvName.toLowerCase()) {
                                        csvRow = row;
                                        break;
                                    }
                                }
                            }

                            if (csvRow) {
                                const importedObject = await loadMaterialObject(modelApi, csvRow);
                                let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
                                if (!matchedMaterial && importedObject.materials && importedObject.materials.length) {
                                    matchedMaterial = importedObject.materials[0];
                                }

                                if (matchedMaterial) {
                                    for (const obj of fabricArmrestObjects) {
                                        const id = getObjectId(obj);
                                        if (id) {
                                            try {
                                                await modelApi.addOrEditMaterial(id, matchedMaterial);
                                                debugLog('Applied fabric material to armrest object', id);
                                            } catch (e) {
                                                debugLog('Failed to apply fabric material to armrest', id, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    debugLog('No fabric selection available to apply to armrest');
                }
            } else if (materialType === 'plastic') {
                // Apply black plastic to fabric_armrest
                const plasticPartsMaterials = (mapping.materials && mapping.materials['plastic_parts']) || null;
                if (plasticPartsMaterials) {
                    const plasticMapping = plasticPartsMaterials['Black Plastic'] ||
                                          plasticPartsMaterials['General Plastic'] ||
                                          plasticPartsMaterials['Plastic Black'];

                    if (plasticMapping) {
                        const csvName = plasticMapping.name;
                        const csvColor = plasticMapping.color;

                        debugLog('Applying black plastic to armrest:', { csvName, csvColor });

                        if (materialsData && materialsData.byName) {
                            let csvRow = materialsData.byName.get(csvName);
                            if (!csvRow) {
                                for (const [name, row] of materialsData.byName.entries()) {
                                    if (name.toLowerCase() === csvName.toLowerCase()) {
                                        csvRow = row;
                                        break;
                                    }
                                }
                            }

                            if (csvRow) {
                                const importedObject = await loadMaterialObject(modelApi, csvRow);
                                let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
                                if (!matchedMaterial && importedObject.materials && importedObject.materials.length) {
                                    matchedMaterial = importedObject.materials[0];
                                }

                                if (matchedMaterial) {
                                    for (const obj of fabricArmrestObjects) {
                                        const id = getObjectId(obj);
                                        if (id) {
                                            try {
                                                await modelApi.addOrEditMaterial(id, matchedMaterial);
                                                debugLog('Applied black plastic to armrest object', id);
                                            } catch (e) {
                                                debugLog('Failed to apply black plastic to armrest', id, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ============================================================================
        // APPLICATION TYPE DETECTION
        // ============================================================================

        function isVariantApplication(applicationName, mapping) {
            if (!applicationName || !mapping) {
                return false;
            }

            // Check explicit variants array (from mapping file)
            if (Array.isArray(mapping.variants)) {
                return mapping.variants
                    .map(v => (v || '').toLowerCase())
                    .includes((applicationName || '').toLowerCase());
            }

            // Fallback: detect by object name patterns
            const objectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];
            const variantIndicators = ['_on_off', '_heights', 'on_off', 'heights'];
            return objectNames.some(name => 
                variantIndicators.some(indicator => 
                    (name || '').toLowerCase().includes(indicator.toLowerCase())
                )
            );
        }

        // ============================================================================
        // UI HANDLING
        // ============================================================================

        function getCurrentAttributeValue(attributeCode) {
            // Try by option ID first
            var optionId = getOptionIdByTitle(attributeCode);

            if (optionId) {
                // Check for selected MageWorx swatch
                var selectedSwatch = document.querySelector('.sw-' + optionId + '.selected');
                if (selectedSwatch) {
                    var value = selectedSwatch.getAttribute('data-option-label') ||
                               selectedSwatch.getAttribute('data-option-tooltip-value') ||
                               selectedSwatch.getAttribute('title');
                    if (value) {
                        return value.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                    }
                }

                // Check for SELECT dropdown
                var selectElement = document.querySelector('select[name="options[' + optionId + ']"]');
                if (selectElement && selectElement.selectedIndex >= 0) {
                    var selectedOption = selectElement.options[selectElement.selectedIndex];
                    if (selectedOption && selectedOption.value && selectedOption.value !== '' && !selectedOption.text.includes('--')) {
                        return selectedOption.text.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                    }
                }
            }

            // Fallback: search all options by label text
            var allFields = document.querySelectorAll('.field.option');
            for (var i = 0; i < allFields.length; i++) {
                var field = allFields[i];
                var label = field.querySelector('label');
                if (label) {
                    var labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                    if (labelText === attributeCode || labelText.includes(attributeCode)) {
                        var selectedSwatch = field.querySelector('.mageworx-swatch-option-custom.selected, .swatchClass.selected, .swatch-option.selected');
                        if (selectedSwatch) {
                            var value = selectedSwatch.getAttribute('data-option-label') ||
                                       selectedSwatch.getAttribute('data-option-tooltip-value') ||
                                       selectedSwatch.getAttribute('title') ||
                                       selectedSwatch.textContent.trim();
                            if (value) {
                                return value.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                            }
                        }

                        var select = field.querySelector('select[name^="options["]');
                        if (select && select.selectedIndex >= 0) {
                            var selectedOption = select.options[select.selectedIndex];
                            if (selectedOption && selectedOption.value && !selectedOption.text.includes('--')) {
                                return selectedOption.text.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                            }
                        }
                    }
                }
            }

            // Fallback for Fabric Options inside .fabric-option-group (e.g. after auto-select)
            if (attributeCode === 'Fabric Options' || (attributeCode && attributeCode.indexOf('Fabric') !== -1)) {
                var fabricGroups = document.querySelectorAll('.fabric-option-group');
                for (var g = 0; g < fabricGroups.length; g++) {
                    var selectedInGroup = fabricGroups[g].querySelector(
                        '.mageworx-swatch-option-custom.selected, .mageworx-swatch-option.selected, ' +
                        '.swatchClass.selected, .swatch-option.selected, [data-option-id].selected'
                    );
                    if (selectedInGroup) {
                        var value = selectedInGroup.getAttribute('data-option-label') ||
                                    selectedInGroup.getAttribute('data-option-tooltip-value') ||
                                    selectedInGroup.getAttribute('title') ||
                                    (selectedInGroup.textContent && selectedInGroup.textContent.trim());
                        if (value) {
                            return value.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                        }
                    }
                }
            }

            return null;
        }

        function getOptionIdByTitle(title) {
            var labels = document.querySelectorAll('.field.option label');
            for (var i = 0; i < labels.length; i++) {
                var label = labels[i];
                var labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                var forAttr = label.getAttribute('for');
                if ((labelText === title || labelText.includes(title)) && forAttr) {
                    var match = forAttr.match(/options_(\d+)/);
                    if (match) {
                        return match[1];
                    }
                }
            }
            return null;
        }

        function bindUiHandlers(modelApi, mapping, materialsData, objectIndex) {
            // Validate mapping structure
            if (!mapping || !mapping.applications || !mapping.materials) {
                console.error('[Vectary] Invalid mapping structure. Expected: { applications: {}, objectNames: {}, materials: {} }');
                console.error('[Vectary] Received mapping:', mapping);
                return;
            }

            console.log('[Vectary] Binding UI handlers with mapping:', {
                applications: Object.keys(mapping.applications || {}),
                objectNames: Object.keys(mapping.objectNames || {}),
                materials: Object.keys(mapping.materials || {})
            });

            // Helper to get application name from field/select
            function getApplicationNameFromElement(element) {
                // Try data-application attribute first
                if (element.getAttribute && element.getAttribute('data-application')) {
                    const appName = element.getAttribute('data-application');
                    debugLog('Found application from data-application:', appName);
                    return appName;
                }

                let labelText = null;
                let label = null;

                // Method 1: Find label by 'for' attribute matching element ID
                if (element.id) {
                    label = document.querySelector('label[for="' + element.id + '"]');
                    if (label) {
                        labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                        debugLog('Found label by for attribute:', labelText);
                    }
                }

                // Method 2: Find field.option container
                if (!labelText) {
                    const field = element.closest ? element.closest('.field.option') : null;
                    if (field) {
                        label = field.querySelector('label');
                        if (label) {
                            labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                            debugLog('Found label in field.option:', labelText);
                        }
                    }
                }

                // Method 3: Find parent container with label (for custom options)
                if (!labelText) {
                    let parent = element.parentElement;
                    let depth = 0;
                    while (parent && depth < 5) {
                        label = parent.querySelector('label');
                        if (label && label.textContent.trim()) {
                            labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                            debugLog('Found label in parent container:', labelText);
                            break;
                        }
                        parent = parent.parentElement;
                        depth++;
                    }
                }

                // Method 4: Try to find by option ID from select name (e.g., options[189]) or ID (e.g., select_189)
                if (!labelText) {
                    let optionId = null;
                    
                    // Extract from name attribute (e.g., options[189])
                    if (element.name) {
                        const optionIdMatch = element.name.match(/options\[(\d+)\]/);
                        if (optionIdMatch) {
                            optionId = optionIdMatch[1];
                        }
                    }
                    
                    // Extract from ID attribute (e.g., select_189)
                    if (!optionId && element.id) {
                        const idMatch = element.id.match(/select_(\d+)/);
                        if (idMatch) {
                            optionId = idMatch[1];
                        }
                    }
                    
                    // Extract from swatch class (e.g., sw-189, swatch-189)
                    if (!optionId && element.classList) {
                        for (let i = 0; i < element.classList.length; i++) {
                            const className = element.classList[i];
                            // Match patterns like: sw-189, swatch-189, sw_189
                            const swatchMatch = className.match(/^(?:sw|swatch)[-_](\d+)$/i);
                            if (swatchMatch) {
                                optionId = swatchMatch[1];
                                debugLog('Extracted option ID from swatch class:', className, '->', optionId);
                                break;
                            }
                        }
                    }
                    
                    // Extract from data attributes (common in MageWorx swatches)
                    // Priority: data-option-id is the option ID (e.g., 189), not the option type ID
                    if (!optionId && element.getAttribute) {
                        // First try data-option-id - this is the option ID we need
                        const dataOptionId = element.getAttribute('data-option-id');
                        if (dataOptionId) {
                            optionId = dataOptionId.toString().replace(/\D/g, ''); // Extract numbers only
                            debugLog('Extracted option ID from data-option-id:', optionId);
                        } else {
                            // Fallback to other data attributes
                            const dataOptionIdAlt = element.getAttribute('data-option_id') ||
                                                  element.getAttribute('data-option');
                            if (dataOptionIdAlt) {
                                optionId = dataOptionIdAlt.toString().replace(/\D/g, '');
                                debugLog('Extracted option ID from data-option_id/data-option:', optionId);
                            }
                        }
                    }
                    
                    // Extract from parent swatch container or nearby swatches
                    if (!optionId) {
                        const swatchContainer = element.closest ? element.closest('.swatch-element-custom, .swatch-attribute, .field.option, .mageworx-swatch-container') : null;
                        if (swatchContainer) {
                            // Try to find option ID from container's class or data attributes
                            if (swatchContainer.classList) {
                                for (let i = 0; i < swatchContainer.classList.length; i++) {
                                    const className = swatchContainer.classList[i];
                                    const swatchMatch = className.match(/^(?:sw|swatch)[-_](\d+)$/i);
                                    if (swatchMatch) {
                                        optionId = swatchMatch[1];
                                        debugLog('Extracted option ID from container class:', className, '->', optionId);
                                        break;
                                    }
                                }
                            }
                            if (!optionId && swatchContainer.getAttribute) {
                                const dataOptionId = swatchContainer.getAttribute('data-option-id') || 
                                                    swatchContainer.getAttribute('data-option_id') ||
                                                    swatchContainer.getAttribute('data-option');
                                if (dataOptionId) {
                                    optionId = dataOptionId.toString().replace(/\D/g, '');
                                    debugLog('Extracted option ID from container data attribute:', optionId);
                                }
                            }
                            
                            // Try to find option ID from selected swatch in container
                            if (!optionId) {
                                const selectedSwatch = swatchContainer.querySelector('.mageworx-swatch-option-custom.selected, .swatchClass.selected, .swatch-option.selected, .sw-' + '[class*="selected"]');
                                if (selectedSwatch && selectedSwatch.classList) {
                                    for (let i = 0; i < selectedSwatch.classList.length; i++) {
                                        const className = selectedSwatch.classList[i];
                                        const swatchMatch = className.match(/^(?:sw|swatch)[-_](\d+)$/i);
                                        if (swatchMatch) {
                                            optionId = swatchMatch[1];
                                            debugLog('Extracted option ID from selected swatch class:', className, '->', optionId);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    // Last resort: Try to find option ID from any swatch with class pattern in the same field
                    if (!optionId) {
                        const field = element.closest ? element.closest('.field.option, .field') : null;
                        if (field) {
                            // Look for any swatch with sw-XXX pattern
                            const allSwatches = field.querySelectorAll('[class*="sw-"], [class*="swatch-"]');
                            for (let i = 0; i < allSwatches.length; i++) {
                                const swatch = allSwatches[i];
                                if (swatch.classList) {
                                    for (let j = 0; j < swatch.classList.length; j++) {
                                        const className = swatch.classList[j];
                                        const swatchMatch = className.match(/^(?:sw|swatch)[-_](\d+)$/i);
                                        if (swatchMatch) {
                                            optionId = swatchMatch[1];
                                            debugLog('Extracted option ID from swatch in field:', className, '->', optionId);
                                            break;
                                        }
                                    }
                                }
                                if (optionId) break;
                            }
                        }
                    }
                    
                    if (optionId) {
                        // Try label[for="options_189"]
                        label = document.querySelector('label[for="options_' + optionId + '"]');
                        if (label) {
                            labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                            debugLog('Found label by option ID (options_):', labelText);
                        }
                        // Try label[for="select_189"]
                        if (!labelText) {
                            label = document.querySelector('label[for="select_' + optionId + '"]');
                            if (label) {
                                labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                                debugLog('Found label by option ID (select_):', labelText);
                            }
                        }
                        // Try field with data-option_id
                        if (!labelText) {
                            const field = document.querySelector('.field.option[data-option_id="' + optionId + '"]');
                            if (field) {
                                label = field.querySelector('label');
                                if (label) {
                                    labelText = label.textContent.trim().replace(/\s*\*\s*$/, '');
                                    debugLog('Found label by data-option_id:', labelText);
                                }
                            }
                        }
                        // Try .field container (Magento standard structure)
                        if (!labelText) {
                            const field = document.querySelector('.field');
                            if (field) {
                                const fieldLabel = field.querySelector('label[for="select_' + optionId + '"], label[for="options_' + optionId + '"]');
                                if (fieldLabel) {
                                    labelText = fieldLabel.textContent.trim().replace(/\s*\*\s*$/, '');
                                    debugLog('Found label in .field container:', labelText);
                                }
                            }
                        }
                    }
                }

                if (!labelText || !mapping.applications) {
                    debugLog('No label text found or mapping.applications missing');
                    return null;
                }

                debugLog('Looking for application matching label:', labelText);

                // Match against mapping.applications keys (case-insensitive)
                // Priority: 1) Exact match, 2) Label starts with key, 3) Key starts with label, 4) Contains match (most specific first)
                const labelLower = labelText.toLowerCase().trim();
                const matches = [];

                for (const key in mapping.applications) {
                    const keyLower = key.toLowerCase().trim();
                    let matchType = null;
                    let matchScore = 0;

                    // Priority 1: Exact match (highest priority)
                    if (keyLower === labelLower) {
                        matchType = 'exact';
                        matchScore = 100;
                    }
                    // Priority 2: Label starts with key (e.g., "Fabric Options" starts with "Fabric Options")
                    else if (labelLower.startsWith(keyLower)) {
                        matchType = 'label-starts-with-key';
                        matchScore = 80;
                    }
                    // Priority 3: Key starts with label (e.g., "Fabric Options" starts with "Fabric")
                    else if (keyLower.startsWith(labelLower)) {
                        matchType = 'key-starts-with-label';
                        matchScore = 60;
                    }
                    // Priority 4: Contains match (lowest priority, but only if key is a complete word)
                    else if (labelLower.includes(keyLower) || keyLower.includes(labelLower)) {
                        // Only allow contains match if the key is a complete word (not a substring)
                        // This prevents "Fabric" from matching "Fabric Options" incorrectly
                        const keyWords = keyLower.split(/\s+/);
                        const labelWords = labelLower.split(/\s+/);
                        const isCompleteWordMatch = keyWords.some(word =>
                            labelWords.some(lw => lw === word || lw.startsWith(word) || word.startsWith(lw))
                        );

                        if (isCompleteWordMatch) {
                            matchType = 'contains-word';
                            matchScore = 40;
                        } else {
                            continue;
                        }
                    } else {
                        continue;
                    }
                    matches.push({
                        key: key,
                        appName: mapping.applications[key],
                        matchType: matchType,
                        score: matchScore
                    });
                }

                // Sort by score (highest first) and return the best match
                if (matches.length > 0) {
                    matches.sort((a, b) => b.score - a.score);
                    const bestMatch = matches[0];
                    debugLog('Matched application:', bestMatch.key, '->', bestMatch.appName, `(match type: ${bestMatch.matchType})`);

                    // If there are multiple high-scoring matches, log a warning
                    if (matches.length > 1 && matches[0].score === matches[1].score) {
                        console.warn('[Vectary] Multiple matches found for label:', labelText, 'Matches:', matches.map(m => `${m.key} (${m.matchType})`));
                    }

                    return bestMatch.appName;
                }

                debugLog('No application match found for label:', labelText, 'Available keys:', Object.keys(mapping.applications || {}));
                return null;
            }

            // Helper to get option label from element
            function getOptionLabelFromElement(element) {
                if (element.tagName === 'SELECT') {
                    const selectedOption = element.options[element.selectedIndex];
                    if (selectedOption && selectedOption.value && !selectedOption.text.includes('--')) {
                        return (selectedOption.text || selectedOption.value || '').trim().replace(/\s*\+\s*\$.*$/, '').trim();
                    }
                    return (element.value || '').trim().replace(/\s*\+\s*\$.*$/, '').trim();
                } else {
                    // Swatch element - try multiple methods to get the label
                    let label = null;
                    
                    // Method 1: Get from data-option-label attribute (most reliable for MageWorx)
                    if (element.getAttribute && element.getAttribute('data-option-label')) {
                        label = element.getAttribute('data-option-label');
                        if (label) {
                            debugLog('Found swatch label from data-option-label:', label);
                            return label.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                        }
                    }
                    
                    // Method 2: Check if element has selected class, get its value
                    if (!label && element.classList && element.classList.contains('selected')) {
                        label = element.getAttribute('data-option-label') ||
                               element.getAttribute('data-option-tooltip-value') ||
                               element.getAttribute('data-option-value') ||
                               element.getAttribute('title') ||
                               element.textContent;
                        if (label) {
                            debugLog('Found swatch label from selected element:', label);
                            return label.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                        }
                    }
                    
                    // Method 2: Find selected swatch in the same container (check for .selected class)
                    const container = element.closest ? element.closest('.swatch-element-custom, .swatch-attribute, .swatch-attribute-options, .field.option, .mageworx-swatch-container') : null;
                    if (container) {
                        // First, check if the element itself is selected
                        if (element.classList && element.classList.contains('selected')) {
                            label = element.getAttribute('data-option-label') ||
                                   element.getAttribute('data-option-tooltip-value') ||
                                   element.getAttribute('data-option-value') ||
                                   element.getAttribute('title') ||
                                   element.textContent;
                            if (label) {
                                debugLog('Found swatch label from selected element itself:', label);
                                return label.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                            }
                        }
                        
                        // Then check for other selected swatches in container (including mageworx-swatch-option.selected)
                        const selectedSwatch = container.querySelector('.mageworx-swatch-option-custom.selected, .mageworx-swatch-option.selected, .swatchClass.selected, .swatch-option.selected, [class*="sw-"][class*="selected"], [data-option-id].selected');
                        if (selectedSwatch) {
                            label = selectedSwatch.getAttribute('data-option-label') ||
                                   selectedSwatch.getAttribute('data-option-tooltip-value') ||
                                   selectedSwatch.getAttribute('data-option-value') ||
                                   selectedSwatch.getAttribute('title') ||
                                   selectedSwatch.textContent;
                            if (label) {
                                debugLog('Found swatch label from selected swatch in container:', label);
                                return label.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                            }
                        }
                    }
                    
                    // Method 3: Get from the clicked element itself (even if not selected yet)
                    label = element.getAttribute('data-option-label') ||
                           element.getAttribute('data-option-tooltip-value') ||
                           element.getAttribute('data-option-value') ||
                           element.getAttribute('title') ||
                           element.getAttribute('aria-label') ||
                           element.textContent;
                    
                    if (label && label.trim()) {
                        debugLog('Found swatch label from element:', label);
                        return label.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                    }
                    
                    // Method 4: Try to find any swatch in the container and get its label
                    if (!label && container) {
                        const anySwatch = container.querySelector('.mageworx-swatch-option-custom, .swatchClass, .swatch-option, [class*="sw-"]');
                        if (anySwatch) {
                            label = anySwatch.getAttribute('data-option-label') ||
                                   anySwatch.getAttribute('data-option-tooltip-value') ||
                                   anySwatch.getAttribute('data-option-value') ||
                                   anySwatch.getAttribute('title') ||
                                   anySwatch.textContent;
                            if (label && label.trim()) {
                                debugLog('Found swatch label from any swatch in container:', label);
                                return label.trim().replace(/\s*\+\s*\$.*$/, '').trim();
                            }
                        }
                    }
                    
                    debugLog('Could not find swatch label for element:', element, 'Container:', container);
                    return '';
                }
            }

            // Debounced handler to prevent rapid selections
            const debouncedHandler = debounce(async function (event) {
                const target = event.target;
                
                // Determine if this is a valid target
                const isSelect = target instanceof HTMLSelectElement;
                const isSwatch = target.classList && (
                    target.classList.contains('swatch-option') ||
                    target.classList.contains('mageworx-swatch-option-custom') ||
                    target.classList.contains('mageworx-swatch-option') ||
                    target.classList.contains('swatchClass') ||
                    target.classList.contains('swatch-option-text') ||
                    target.classList.contains('swatch-option-image')
                ) || target.hasAttribute('data-option-id'); // MageWorx swatches have this
                
                // Check if target is inside a swatch
                const swatchParent = target.closest ? (
                    target.closest('.swatch-option') ||
                    target.closest('.mageworx-swatch-option-custom') ||
                    target.closest('.mageworx-swatch-option') ||
                    target.closest('.swatchClass') ||
                    target.closest('.swatch-element-custom') ||
                    target.closest('.mageworx-swatch-container')
                ) : null;
                
                const isSwatchWrapper = target.classList && (
                    target.classList.contains('swatch-element-custom') ||
                    target.classList.contains('swatch-attribute-options') ||
                    target.classList.contains('swatch-attribute') ||
                    target.classList.contains('mageworx-swatch-container')
                );
                const isInsideSwatch = !!swatchParent;

                if (!isSelect && !isSwatch && !isSwatchWrapper && !isInsideSwatch) {
                    return;
                }

                // For swatches, find the actual swatch element
                let actualTarget = target;
                
                // If clicking inside a swatch, use the parent swatch element
                if (isInsideSwatch && swatchParent) {
                    actualTarget = swatchParent;
                    console.log('[Vectary] Using parent swatch element:', actualTarget);
                }
                // If clicking on a swatch wrapper, find the clicked or selected swatch
                else if (isSwatchWrapper) {
                    const allSwatches = target.querySelectorAll('.mageworx-swatch-option-custom, .mageworx-swatch-option, .swatchClass, .swatch-option, [class*="sw-"], [data-option-id]');
                    let clickedSwatch = null;
                    
                    // Priority 1: Find swatch that contains the event target (the actual clicked element)
                    if (event.target && event.target !== target) {
                        allSwatches.forEach(swatch => {
                            if (swatch === event.target || swatch.contains(event.target)) {
                                clickedSwatch = swatch;
                            }
                        });
                    }
                    
                    // Priority 2: Find swatch with 'selected' class (most reliable after click)
                    if (!clickedSwatch) {
                        allSwatches.forEach(swatch => {
                            if (swatch.classList.contains('selected')) {
                                clickedSwatch = swatch;
                            }
                        });
                    }
                    
                    // Priority 3: Find swatch with 'active' class
                    if (!clickedSwatch) {
                        allSwatches.forEach(swatch => {
                            if (swatch.classList.contains('active')) {
                                clickedSwatch = swatch;
                            }
                        });
                    }
                    
                    if (clickedSwatch) {
                        actualTarget = clickedSwatch;
                        console.log('[Vectary] Found clicked swatch in wrapper:', actualTarget);
                    } else if (allSwatches.length > 0) {
                        // Use the first swatch if we can't determine which was clicked
                        actualTarget = allSwatches[0];
                        console.log('[Vectary] Using first swatch in wrapper:', actualTarget);
                    }
                }
                // If clicking directly on a swatch, use it
                else if (isSwatch) {
                    actualTarget = target;
                    console.log('[Vectary] Using direct swatch element:', actualTarget);
                }

                // Only update Vectary for options in the "Design Your Own" section
                const designSection = document.querySelector('.design-product-details-section');
                if (designSection && actualTarget && !designSection.contains(actualTarget)) {
                    return;
                }

                // Get application name and option value
                const applicationName = getApplicationNameFromElement(actualTarget);
                const optionLabel = getOptionLabelFromElement(actualTarget);

                if (!applicationName || !optionLabel) {
                    console.warn('[Vectary] Could not determine application or option:', { 
                        applicationName, 
                        optionLabel, 
                        element: actualTarget,
                        elementTag: actualTarget.tagName,
                        elementClasses: actualTarget.className
                    });
                    return;
                }

                // Validate applicationName exists in mapping before proceeding
                const validApplicationNames = Object.values(mapping.applications || {});
                if (!validApplicationNames.includes(applicationName)) {
                    console.error('[Vectary] Invalid application name detected:', applicationName,
                        'Valid applications:', validApplicationNames,
                        'Element:', actualTarget);
                    return;
                }

                // Validate that this application has object names defined
                const targetObjectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];
                if (!targetObjectNames.length) {
                    console.error('[Vectary] No object names defined for application:', applicationName,
                        'Available applications with object names:', Object.keys(mapping.objectNames || {}));
                    return;
                }

                console.log('[Vectary] Processing selection:', {
                    applicationName,
                    optionLabel,
                    targetObjects: targetObjectNames
                });

                // Show loading state
                if (isSelect) {
                    actualTarget.disabled = true;
                    actualTarget.style.opacity = '0.6';
                }

                try {
                    // Track fabric selection for armrest use
                    if (applicationName === 'fabric_seat') {
                        currentFabricSelection = optionLabel;
                        debugLog('Tracked fabric selection:', currentFabricSelection);
                    }

                    // Track armrest selection
                    if (applicationName === 'fabric_armrest') {
                        currentArmrestSelection = optionLabel;
                        debugLog('Tracked armrest selection:', currentArmrestSelection);
                        await applyArmrest(modelApi, mapping, objectIndex, applicationName, optionLabel, materialsData);
                    }
                    // Check if it's a variant application (including base)
                    else if (isVariantApplication(applicationName, mapping)) {
                        // For base, try object visibility first, then fallback to variant
                        if (applicationName === 'base') {
                            try {
                                await applyBaseOptions(modelApi, mapping, objectIndex, applicationName, optionLabel, materialsData);
                            } catch (baseErr) {
                                // Fallback: try variant approach if object visibility fails
                                debugLog('Base options object visibility failed, trying variant approach:', baseErr);
                                await applyVariant(modelApi, mapping, objectIndex, applicationName, optionLabel);
                            }
                        } else {
                            await applyVariant(modelApi, mapping, objectIndex, applicationName, optionLabel);
                        }
                    } else {
                        await applyMaterial(modelApi, mapping, objectIndex, applicationName, optionLabel, materialsData);
                    }
                    debugLog('Successfully applied:', applicationName, '->', optionLabel);
                } catch (err) {
                    console.error('Error applying selection for', applicationName, optionLabel, err);
                    console.error('Full error details:', err.stack || err);
                } finally {
                    if (isSelect) {
                        actualTarget.disabled = false;
                        actualTarget.style.opacity = '1';
                    }
                }
            }, 300); // 300ms debounce

            // Bind to all select elements (including dynamically added ones)
            function bindSelects() {
                document.querySelectorAll('select[name^="options["]').forEach(select => {
                    if (!select.hasAttribute('data-vectary-bound')) {
                        select.setAttribute('data-vectary-bound', '1');
                        select.addEventListener('change', debouncedHandler);
                    }
                });
            }

            // Initial bind
            bindSelects();

            // Re-bind on DOM changes (for dynamically added options)
            const observer = new MutationObserver(function(mutations) {
                let shouldRebind = false;
                mutations.forEach(function(mutation) {
                    if (mutation.addedNodes.length) {
                        mutation.addedNodes.forEach(function(node) {
                            if (node.nodeType === 1) { // Element node
                                if (node.tagName === 'SELECT' || node.querySelector('select[name^="options["]')) {
                                    shouldRebind = true;
                                }
                            }
                        });
                    }
                });
                if (shouldRebind) {
                    bindSelects();
                }
            });

            // Observe the options container
            const optionsContainer = document.querySelector('.product-options-wrapper, .fieldset, .product-options-bottom');
            if (optionsContainer) {
                observer.observe(optionsContainer, {
                    childList: true,
                    subtree: true
                });
            }

            // Track pending swatch clicks to avoid duplicate processing
            const pendingSwatchClicks = new WeakMap();
            
            // MutationObserver to watch for swatch selection changes
            const swatchObserver = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                        const target = mutation.target;
                        // Check if this is a swatch that just got the 'selected' class
                        if (target.classList && target.classList.contains('selected')) {
                            const isSwatch = target.classList.contains('swatch-option') ||
                                            target.classList.contains('mageworx-swatch-option-custom') ||
                                            target.classList.contains('mageworx-swatch-option') ||
                                            target.classList.contains('swatchClass') ||
                                            target.hasAttribute('data-option-id');
                            
                            if (isSwatch && !pendingSwatchClicks.has(target)) {
                                console.log('[Vectary] Swatch selected via MutationObserver:', target);
                                pendingSwatchClicks.set(target, true);
                                
                                // Process the selection
                                setTimeout(() => {
                                    const event = {
                                        target: target,
                                        currentTarget: document,
                                        type: 'swatch-selected',
                                        timeStamp: Date.now()
                                    };
                                    debouncedHandler(event);
                                    pendingSwatchClicks.delete(target);
                                }, 50); // Small delay to ensure all DOM updates are complete
                            }
                        }
                    }
                });
            });
            
            // Observe all swatch containers for class changes
            const swatchContainers = document.querySelectorAll('.swatch-element-custom, .swatch-attribute, .swatch-attribute-options, .field.option, .mageworx-swatch-container');
            swatchContainers.forEach(function(container) {
                swatchObserver.observe(container, {
                    attributes: true,
                    attributeFilter: ['class'],
                    subtree: true
                });
            });
            
            // Also observe the options container for dynamically added swatches
            if (optionsContainer) {
                const swatchContainerObserver = new MutationObserver(function(mutations) {
                    mutations.forEach(function(mutation) {
                        mutation.addedNodes.forEach(function(node) {
                            if (node.nodeType === 1) { // Element node
                                const newContainers = node.querySelectorAll ? node.querySelectorAll('.swatch-element-custom, .swatch-attribute, .swatch-attribute-options, .field.option, .mageworx-swatch-container') : [];
                                newContainers.forEach(function(container) {
                                    swatchObserver.observe(container, {
                                        attributes: true,
                                        attributeFilter: ['class'],
                                        subtree: true
                                    });
                                });
                            }
                        });
                    });
                });
                swatchContainerObserver.observe(optionsContainer, {
                    childList: true,
                    subtree: true
                });
            }
            
            // Bind to swatch elements using event delegation (fallback if MutationObserver misses it)
            document.addEventListener('click', function(event) {
                const target = event.target;
                
                // Check if clicked element is a swatch (including mageworx-swatch-option)
                const isSwatch = target.classList && (
                    target.classList.contains('swatch-option') ||
                    target.classList.contains('mageworx-swatch-option-custom') ||
                    target.classList.contains('mageworx-swatch-option') ||
                    target.classList.contains('swatchClass') ||
                    target.classList.contains('swatch-option-text') ||
                    target.classList.contains('swatch-option-image') ||
                    target.hasAttribute('data-option-id') // MageWorx swatches have this
                );
                
                // Check if clicked element is inside a swatch
                const isInsideSwatch = target.closest && (
                    target.closest('.swatch-option') ||
                    target.closest('.mageworx-swatch-option-custom') ||
                    target.closest('.mageworx-swatch-option') ||
                    target.closest('.swatchClass') ||
                    target.closest('.swatch-element-custom') ||
                    target.closest('.mageworx-swatch-container')
                );
                
                // Check if clicked element is a swatch wrapper
                const isSwatchWrapper = target.classList && (
                    target.classList.contains('swatch-element-custom') ||
                    target.classList.contains('swatch-attribute-options') ||
                    target.classList.contains('swatch-attribute') ||
                    target.classList.contains('mageworx-swatch-container')
                );

                if (isSwatch || isInsideSwatch || isSwatchWrapper) {
                    console.log('[Vectary] Swatch click detected:', {
                        target: target,
                        isSwatch: isSwatch,
                        isInsideSwatch: !!isInsideSwatch,
                        isSwatchWrapper: isSwatchWrapper,
                        classes: target.className,
                        parentClasses: target.closest ? (target.closest('.swatch-element-custom, .swatch-option, .mageworx-swatch-option-custom')?.className || 'none') : 'none'
                    });
                    
                    // Find the swatch container to search for selected swatch after delay
                    const swatchContainer = target.closest ? (
                        target.closest('.swatch-element-custom, .swatch-attribute, .swatch-attribute-options, .field.option, .mageworx-swatch-container') ||
                        (isSwatchWrapper ? target : null)
                    ) : null;
                    
                    // Small delay to ensure swatch selection state is updated (MageWorx needs time to add 'selected' class)
                    // This is a fallback if MutationObserver doesn't catch it
                    setTimeout(() => {
                        // Skip if already processed by MutationObserver
                        if (pendingSwatchClicks.has(target)) {
                            return;
                        }
                        
                        console.log('[Vectary] Processing swatch click after delay (fallback)');
                        
                        // Find the selected swatch element after MageWorx has updated the DOM
                        let selectedSwatch = null;
                        
                        if (swatchContainer) {
                            // Priority 1: Find swatch with 'selected' class
                            selectedSwatch = swatchContainer.querySelector(
                                '.mageworx-swatch-option-custom.selected, .mageworx-swatch-option.selected, .swatchClass.selected, .swatch-option.selected, [class*="sw-"][class*="selected"], [data-option-id].selected'
                            );
                            
                            // Priority 2: If no selected found, try to find the clicked swatch by data-option-id
                            if (!selectedSwatch && target.hasAttribute && target.hasAttribute('data-option-id')) {
                                const optionId = target.getAttribute('data-option-id');
                                selectedSwatch = swatchContainer.querySelector(`[data-option-id="${optionId}"]`);
                            }
                            
                            // Priority 3: Find any swatch with the same classes as the clicked element
                            if (!selectedSwatch && target.classList) {
                                const targetClasses = Array.from(target.classList);
                                const matchingSwatch = swatchContainer.querySelector(
                                    targetClasses.map(cls => '.' + cls).join(',')
                                );
                                if (matchingSwatch) {
                                    selectedSwatch = matchingSwatch;
                                }
                            }
                        }
                        
                        // Fallback: Use the original target if we couldn't find a selected swatch
                        const finalTarget = selectedSwatch || target;
                        
                        console.log('[Vectary] Using swatch element (fallback):', {
                            found: !!selectedSwatch,
                            element: finalTarget,
                            classes: finalTarget.className,
                            dataOptionId: finalTarget.getAttribute ? finalTarget.getAttribute('data-option-id') : null,
                            dataOptionLabel: finalTarget.getAttribute ? finalTarget.getAttribute('data-option-label') : null
                        });
                        
                        // Create a new event-like object with the found selected swatch
                        const updatedEvent = {
                            target: finalTarget,
                            currentTarget: event.currentTarget,
                            type: event.type,
                            timeStamp: event.timeStamp
                        };
                        
                        // Re-trigger the handler with the correct selected swatch
                        debouncedHandler(updatedEvent);
                    }, 300); // Increased delay to ensure MageWorx has updated the selected class
                }
            }, true); // Use capture phase for better event handling

            /**
             * Helper function to check if an application is auto-applied (fabric, metal, arm rest)
             * These options are auto-applied directly to the model, not through UI selection handler
             */
            function isAutoAppliedOption(applicationName) {
                return applicationName === 'fabric_seat' ||
                       applicationName === 'black metal' ||
                       applicationName === 'fabric_armrest';
            }

            /**
             * Auto-select the first available value for each custom option
             * and propagate the selection into the Vectary pipeline.
             */
            function autoSelectInitialOptions() {
                try {
                    // Collect every element we auto-select so we can explicitly apply each to the 3D model
                    const elementsToApplyToModel = [];

                    // 1) Handle Fabric swatches: only ONE default selection (UI only, not applied to model)
                    const fabricGroups = document.querySelectorAll('.fabric-option-group');

                    if (fabricGroups.length > 0) {
                        const firstFabricGroup = fabricGroups[0];

                        const alreadySelectedFabric = firstFabricGroup.querySelector(
                            '.mageworx-swatch-option-custom.selected, ' +
                            '.mageworx-swatch-option.selected, ' +
                            '.swatchClass.selected, ' +
                            '.swatch-option.selected, ' +
                            '[data-option-id].selected'
                        );

                        if (!alreadySelectedFabric) {
                            const firstFabricSwatch = firstFabricGroup.querySelector(
                                '.mageworx-swatch-option-custom, ' +
                                '.mageworx-swatch-option, ' +
                                '.swatchClass, ' +
                                '.swatch-option, ' +
                                '.mageworx-swatch-container [data-option-id]'
                            );

                            if (firstFabricSwatch) {
                                firstFabricSwatch.click();
                            }
                        }
                    }

                    // 2) Handle native select elements (dropdowns)
                    const selects = document.querySelectorAll('select[name^="options["]');
                    for (let i = 0; i < selects.length; i++) {
                        const select = selects[i];
                        if (select.value && select.value !== '') {
                            continue;
                        }

                        // Find first valid option once (optimized: iterate directly instead of Array.from for better performance)
                        let firstValid = null;
                        for (let j = 0; j < select.options.length; j++) {
                            const opt = select.options[j];
                            if (opt.value && !opt.disabled) {
                                firstValid = opt;
                                break;
                            }
                        }
                        if (!firstValid) {
                            continue;
                        }

                        // Check if this select is for fabric, metal, or arm rest (auto-applied options)
                        const applicationName = getApplicationNameFromElement(select);
                        if (isAutoAppliedOption(applicationName)) {
                            // Still auto-select in UI, but don't add to elementsToApplyToModel
                            select.value = firstValid.value;
                            const changeEvent = new Event('change', { bubbles: true });
                            select.dispatchEvent(changeEvent);
                            continue; // Skip adding to elementsToApplyToModel
                        }

                        select.value = firstValid.value;
                        const changeEvent = new Event('change', { bubbles: true });
                        select.dispatchEvent(changeEvent);
                        elementsToApplyToModel.push(select);
                    }

                    // 3) Handle other swatch-based options (non-fabric)
                    const swatchGroups = document.querySelectorAll(
                        '.fabric-group-swatches, .swatch-attribute-options, .swatch-attribute, .field.option'
                    );
                    const processedGroups = new Set();
                    // Cache selector strings for better performance
                    const selectedSelector = '.mageworx-swatch-option-custom.selected, .mageworx-swatch-option.selected, .swatchClass.selected, .swatch-option.selected, [data-option-id].selected';
                    const swatchSelector = '.mageworx-swatch-option-custom, .mageworx-swatch-option, .swatchClass, .swatch-option, .mageworx-swatch-container [data-option-id]';

                    for (let i = 0; i < swatchGroups.length; i++) {
                        const group = swatchGroups[i];
                        // Skip fabric groups (already handled in section 1)
                        if (group.closest('.fabric-option-group')) {
                            continue;
                        }

                        const groupKey =
                            group.getAttribute('data-option-id') ||
                            group.id ||
                            null;

                        if (groupKey && processedGroups.has(groupKey)) {
                            continue;
                        }

                        const alreadySelected = group.querySelector(selectedSelector);
                        if (alreadySelected) {
                            if (groupKey) {
                                processedGroups.add(groupKey);
                            }
                            continue;
                        }

                        const firstSwatch = group.querySelector(swatchSelector);
                        if (!firstSwatch) {
                            continue;
                        }

                        // Check if this swatch is for fabric, metal, or arm rest (auto-applied options)
                        const applicationName = getApplicationNameFromElement(firstSwatch);
                        if (isAutoAppliedOption(applicationName)) {
                            // Still auto-select in UI, but don't add to elementsToApplyToModel
                            if (groupKey) {
                                processedGroups.add(groupKey);
                            }
                            firstSwatch.click();
                            continue; // Skip adding to elementsToApplyToModel
                        }

                        if (groupKey) {
                            processedGroups.add(groupKey);
                        }

                        firstSwatch.click();
                        elementsToApplyToModel.push(firstSwatch);
                    }

                    // Apply each auto-selected option to the 3D model (batch with reduced delays)
                    if (elementsToApplyToModel.length > 0) {
                        // Use requestAnimationFrame for first element, then batch others
                        elementsToApplyToModel.forEach(function (el, i) {
                            const delay = i === 0 ? 100 : 200 + (i - 1) * 150;
                            setTimeout(function () {
                                const syntheticEvent = {
                                    target: el,
                                    currentTarget: document,
                                    type: 'auto-select',
                                    timeStamp: Date.now()
                                };
                                debouncedHandler(syntheticEvent);
                            }, delay);
                        });
                    }
                } catch (e) {
                    console.warn('[Vectary] Failed to auto-select initial options', e);
                }
            }

            // Run auto-selection shortly after bindings are in place so Vectary receives the events
            requestAnimationFrame(function() {
                setTimeout(autoSelectInitialOptions, 200);
            });
        }

        // ============================================================================
        // AUTO-APPLY PLASTIC PARTS MATERIAL
        // ============================================================================

        async function applyPlasticPartsMaterial(modelApi, mapping, objectIndex, materialsData) {
            try {
                // Check if plastic_parts application exists in mapping
                const plasticPartsApp = mapping.applications && mapping.applications['Plastic Parts'];
                if (!plasticPartsApp || plasticPartsApp !== 'plastic_parts') {
                    debugLog('Plastic parts application not found in mapping, skipping auto-apply');
                    return;
                }

                const plasticPartsMaterials = (mapping.materials && mapping.materials['plastic_parts']) || null;
                if (!plasticPartsMaterials) {
                    debugLog('Plastic parts materials not found in mapping, skipping auto-apply');
                    return;
                }

                // Use "Black Plastic" as default
                const plasticMapping = plasticPartsMaterials['Black Plastic'] || 
                                      plasticPartsMaterials['General Plastic'] ||
                                      plasticPartsMaterials['Plastic Black'];
                
                if (!plasticMapping) {
                    debugLog('Black plastic material mapping not found, skipping auto-apply');
                    return;
                }

                const csvName = plasticMapping.name;
                const csvColor = plasticMapping.color;

                debugLog('Auto-applying black plastic to plastic parts:', { csvName, csvColor });

                // Find material in CSV
                if (!materialsData || !materialsData.byName) {
                    debugLog('Materials data not loaded, skipping plastic parts auto-apply');
                    return;
                }

                let csvRow = materialsData.byName.get(csvName);
                if (!csvRow) {
                    // Try case-insensitive search
                    for (const [name, row] of materialsData.byName.entries()) {
                        if (name.toLowerCase() === csvName.toLowerCase()) {
                            csvRow = row;
                            debugLog('Found plastic material with case-insensitive match:', name);
                            break;
                        }
                    }
                }

                if (!csvRow) {
                    debugLog('Black plastic material not found in CSV, skipping auto-apply');
                    return;
                }

                // Load the material object
                const importedObject = await loadMaterialObject(modelApi, csvRow);

                // Find matching material
                let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
                if (!matchedMaterial) {
                    if (importedObject.materials && importedObject.materials.length) {
                        matchedMaterial = importedObject.materials[0];
                        debugLog('No exact plastic material match found, falling back to first material');
                    } else {
                        debugLog('No matching plastic material found in imported object');
                        return;
                    }
                }

                // Get target object names for plastic parts
                const targetObjectNames = (mapping.objectNames && mapping.objectNames['plastic_parts']) || [];
                if (!targetObjectNames.length) {
                    debugLog('No plastic parts object names defined in mapping');
                    return;
                }

                debugLog('Applying black plastic to plastic parts:', targetObjectNames);

                // Apply material to all plastic parts
                let appliedCount = 0;
                const defaultMaterial = importedObject && importedObject.materials && importedObject.materials.length
                    ? importedObject.materials[0]
                    : matchedMaterial;

                for (const name of targetObjectNames) {
                    // Use flexible matching for wheels/glides
                    let objs = objectIndex.get(name) || [];
                    
                    // If not found, try flexible search for wheels/glides
                    if (objs.length === 0 && (name === 'plastic_wheels' || name === 'glides')) {
                        objs = findObjectsByName(objectIndex, name);
                    }
                    
                    // Also try variations for headrest/chair back/armrest
                    if (objs.length === 0) {
                        const nameLower = name.toLowerCase();
                        for (const [objName, objList] of objectIndex.entries()) {
                            const objNameLower = objName.toLowerCase();
                            if (objNameLower.includes(nameLower) || nameLower.includes(objNameLower)) {
                                objs.push(...objList);
                            }
                        }
                    }

                    debugLog(`Found ${objs.length} objects for plastic part "${name}"`);

                    for (const obj of objs) {
                        const id = getObjectId(obj);
                        if (!id) continue;

                        try {
                            await modelApi.addOrEditMaterial(id, matchedMaterial);
                            appliedCount++;
                            debugLog('Applied black plastic to object', id, '(', name, ')');
                        } catch (e) {
                            debugLog('Failed to apply plastic material to', id, ', trying default', e);
                            if (defaultMaterial && defaultMaterial !== matchedMaterial) {
                                try {
                                    await modelApi.addOrEditMaterial(id, defaultMaterial);
                                    appliedCount++;
                                    debugLog('Applied default plastic material to object', id);
                                } catch (e2) {
                                    debugLog('Failed to apply both plastic materials to object', id, e2);
                                }
                            }
                        }
                    }
                }

                if (appliedCount > 0) {
                    debugLog('Auto-applied black plastic to', appliedCount, 'plastic parts');
                } else {
                    debugLog('No plastic parts found to apply material to');
                }
            } catch (err) {
                debugLog('Error auto-applying plastic parts material (non-critical):', err);
                // Don't throw - this is a non-critical operation
            }
        }

        // ============================================================================
        // AUTO-APPLY DEFAULT FABRIC MATERIAL
        // ============================================================================

        async function applyDefaultFabric(modelApi, mapping, objectIndex, materialsData) {
            try {
                // Check if fabric_seat application exists in mapping
                const fabricSeatApp = mapping.applications && mapping.applications['Fabric Options'];
                if (!fabricSeatApp || fabricSeatApp !== 'fabric_seat') {
                    debugLog('Fabric seat application not found in mapping, skipping auto-apply');
                    return;
                }

                const fabricMaterials = (mapping.materials && mapping.materials['fabric_seat']) || null;
                if (!fabricMaterials) {
                    debugLog('Fabric materials not found in mapping, skipping auto-apply');
                    return;
                }

                // Use "Autumn (kvadrat) - 101" as default
                const fabricMapping = fabricMaterials['Autumn (kvadrat) - 101'];

                if (!fabricMapping) {
                    debugLog('Autumn (kvadrat) - 101 fabric material mapping not found, skipping auto-apply');
                    return;
                }

                const csvName = fabricMapping.name;
                const csvColor = fabricMapping.color;

                debugLog('Auto-applying Autumn (kvadrat) - 101 fabric to fabric seat:', { csvName, csvColor });

                // Find material in CSV
                if (!materialsData || !materialsData.byName) {
                    debugLog('Materials data not loaded, skipping fabric auto-apply');
                    return;
                }

                let csvRow = materialsData.byName.get(csvName);
                if (!csvRow) {
                    // Try case-insensitive search
                    for (const [name, row] of materialsData.byName.entries()) {
                        if (name.toLowerCase() === csvName.toLowerCase()) {
                            csvRow = row;
                            debugLog('Found fabric material with case-insensitive match:', name);
                            break;
                        }
                    }
                }

                if (!csvRow) {
                    debugLog('Autumn (kvadrat) - 101 fabric material not found in CSV, skipping auto-apply');
                    return;
                }

                // Load the material object
                const importedObject = await loadMaterialObject(modelApi, csvRow);

                // Find matching material
                let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
                if (!matchedMaterial) {
                    if (importedObject.materials && importedObject.materials.length) {
                        matchedMaterial = importedObject.materials[0];
                        debugLog('No exact fabric material match found, falling back to first material');
                    } else {
                        debugLog('No matching fabric material found in imported object');
                        return;
                    }
                }

                // Get target object names for fabric seat
                const targetObjectNames = (mapping.objectNames && mapping.objectNames['fabric_seat']) || [];
                if (!targetObjectNames.length) {
                    debugLog('No fabric seat object names defined in mapping');
                    return;
                }

                debugLog('Applying Autumn (kvadrat) - 101 fabric to fabric seat:', targetObjectNames);

                // Apply material to all fabric seat objects
                let appliedCount = 0;
                const defaultMaterial = importedObject && importedObject.materials && importedObject.materials.length
                    ? importedObject.materials[0]
                    : matchedMaterial;

                for (const name of targetObjectNames) {
                    const objs = objectIndex.get(name) || [];
                    debugLog(`Found ${objs.length} objects for fabric part "${name}"`);

                    for (const obj of objs) {
                        const id = getObjectId(obj);
                        if (!id) continue;

                        try {
                            await modelApi.addOrEditMaterial(id, matchedMaterial);
                            appliedCount++;
                            debugLog('Applied Autumn (kvadrat) - 101 fabric to object', id, '(', name, ')');
                        } catch (e) {
                            debugLog('Failed to apply fabric material to', id, ', trying default', e);
                            if (defaultMaterial && defaultMaterial !== matchedMaterial) {
                                try {
                                    await modelApi.addOrEditMaterial(id, defaultMaterial);
                                    appliedCount++;
                                    debugLog('Applied default fabric material to object', id);
                                } catch (e2) {
                                    debugLog('Failed to apply both fabric materials to object', id, e2);
                                }
                            }
                        }
                    }
                }

                if (appliedCount > 0) {
                    debugLog('Auto-applied Autumn (kvadrat) - 101 fabric to', appliedCount, 'fabric seat objects');
                    // Track fabric selection for armrest use
                    currentFabricSelection = 'Autumn (kvadrat) - 101';
                } else {
                    debugLog('No fabric seat objects found to apply material to');
                }
            } catch (err) {
                debugLog('Error auto-applying fabric material (non-critical):', err);
                // Don't throw - this is a non-critical operation
            }
        }

        // ============================================================================
        // AUTO-APPLY DEFAULT METAL MATERIAL
        // ============================================================================

        async function applyDefaultMetal(modelApi, mapping, objectIndex, materialsData) {
            try {
                // Check if black metal application exists in mapping
                const metalApp = mapping.applications && mapping.applications['Metal Finish'];
                if (!metalApp || metalApp !== 'black metal') {
                    debugLog('Black metal application not found in mapping, skipping auto-apply');
                    return;
                }

                const metalMaterials = (mapping.materials && mapping.materials['black metal']) || null;
                if (!metalMaterials) {
                    debugLog('Metal materials not found in mapping, skipping auto-apply');
                    return;
                }

                // Use "Black Metal" as default
                const metalMapping = metalMaterials['Black Metal'];

                if (!metalMapping) {
                    debugLog('Black Metal material mapping not found, skipping auto-apply');
                    return;
                }

                const csvName = metalMapping.name;
                const csvColor = metalMapping.color;

                debugLog('Auto-applying black metal to metal objects:', { csvName, csvColor });

                // Find material in CSV
                if (!materialsData || !materialsData.byName) {
                    debugLog('Materials data not loaded, skipping metal auto-apply');
                    return;
                }

                let csvRow = materialsData.byName.get(csvName);
                if (!csvRow) {
                    // Try case-insensitive search
                    for (const [name, row] of materialsData.byName.entries()) {
                        if (name.toLowerCase() === csvName.toLowerCase()) {
                            csvRow = row;
                            debugLog('Found metal material with case-insensitive match:', name);
                            break;
                        }
                    }
                }

                if (!csvRow) {
                    debugLog('Black metal material not found in CSV, skipping auto-apply');
                    return;
                }

                // Load the material object
                const importedObject = await loadMaterialObject(modelApi, csvRow);

                // Find matching material
                let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
                if (!matchedMaterial) {
                    if (importedObject.materials && importedObject.materials.length) {
                        matchedMaterial = importedObject.materials[0];
                        debugLog('No exact metal material match found, falling back to first material');
                    } else {
                        debugLog('No matching metal material found in imported object');
                        return;
                    }
                }

                // Get target object names for black metal
                const targetObjectNames = (mapping.objectNames && mapping.objectNames['black metal']) || [];
                if (!targetObjectNames.length) {
                    debugLog('No black metal object names defined in mapping');
                    return;
                }

                debugLog('Applying black metal to metal objects:', targetObjectNames);

                // Apply material to all black metal objects
                let appliedCount = 0;
                const defaultMaterial = importedObject && importedObject.materials && importedObject.materials.length
                    ? importedObject.materials[0]
                    : matchedMaterial;

                for (const name of targetObjectNames) {
                    const objs = objectIndex.get(name) || [];
                    debugLog(`Found ${objs.length} objects for metal part "${name}"`);

                    for (const obj of objs) {
                        const id = getObjectId(obj);
                        if (!id) continue;

                        try {
                            await modelApi.addOrEditMaterial(id, matchedMaterial);
                            appliedCount++;
                            debugLog('Applied black metal to object', id, '(', name, ')');
                        } catch (e) {
                            debugLog('Failed to apply metal material to', id, ', trying default', e);
                            if (defaultMaterial && defaultMaterial !== matchedMaterial) {
                                try {
                                    await modelApi.addOrEditMaterial(id, defaultMaterial);
                                    appliedCount++;
                                    debugLog('Applied default metal material to object', id);
                                } catch (e2) {
                                    debugLog('Failed to apply both metal materials to object', id, e2);
                                }
                            }
                        }
                    }
                }

                if (appliedCount > 0) {
                    debugLog('Auto-applied black metal to', appliedCount, 'metal objects');
                } else {
                    debugLog('No metal objects found to apply material to');
                }
            } catch (err) {
                debugLog('Error auto-applying metal material (non-critical):', err);
                // Don't throw - this is a non-critical operation
            }
        }

        // ============================================================================
        // AUTO-APPLY DEFAULT ARMREST
        // ============================================================================

        async function applyDefaultArmrest(modelApi, mapping, objectIndex, materialsData) {
            try {
                // Check if fabric_armrest application exists in mapping
                const armrestApp = mapping.applications && mapping.applications['Armrest'];
                if (!armrestApp || armrestApp !== 'fabric_armrest') {
                    debugLog('Armrest application not found in mapping, skipping auto-apply');
                    return;
                }

                const armrestMaterials = (mapping.materials && mapping.materials['fabric_armrest']) || null;
                if (!armrestMaterials) {
                    debugLog('Armrest materials not found in mapping, skipping auto-apply');
                    return;
                }

                // Use "Plastic Armrest" as default
                const armrestMapping = armrestMaterials['Plastic Armrest'];
                if (!armrestMapping) {
                    debugLog('Plastic Armrest mapping not found, skipping auto-apply');
                    return;
                }

                const variantValue = armrestMapping.color || armrestMapping.name || 'Plastic Armrest';
                const materialType = armrestMapping.material_type; // Should be "plastic"
                const targetObjectNames = (mapping.objectNames && mapping.objectNames['fabric_armrest']) || [];

                if (!targetObjectNames.length) {
                    debugLog('No armrest object names defined in mapping');
                    return;
                }

                debugLog('Auto-applying Plastic Armrest:', { variantValue, materialType, targetObjectNames });

                // First, set the variant state (armrest on/off)
                const currentState = (await modelApi.getConfigurationState()) || [];
                const updatedState = Array.isArray(currentState) ? currentState.slice() : [];

                let matchedCount = 0;
                updatedState.forEach(entry => {
                    if (!entry) return;
                    const variantName = entry.variant;
                    if (variantName && targetObjectNames.includes(variantName)) {
                        entry.active_object = variantValue;
                        if (entry.active_object_instanceId) {
                            delete entry.active_object_instanceId;
                        }
                        matchedCount++;
                    }
                });

                if (matchedCount > 0) {
                    debugLog('Applying armrest variant', variantValue);
                    await modelApi.setConfigurationState(updatedState);
                }

                // Apply black plastic to fabric_armrest objects
                if (materialType === 'plastic') {
                    const plasticPartsMaterials = (mapping.materials && mapping.materials['plastic_parts']) || null;
                    if (plasticPartsMaterials) {
                        const plasticMapping = plasticPartsMaterials['Black Plastic'] ||
                                              plasticPartsMaterials['General Plastic'] ||
                                              plasticPartsMaterials['Plastic Black'];

                        if (plasticMapping) {
                            const csvName = plasticMapping.name;
                            const csvColor = plasticMapping.color;

                            debugLog('Applying black plastic to armrest:', { csvName, csvColor });

                            if (materialsData && materialsData.byName) {
                                let csvRow = materialsData.byName.get(csvName);
                                if (!csvRow) {
                                    for (const [name, row] of materialsData.byName.entries()) {
                                        if (name.toLowerCase() === csvName.toLowerCase()) {
                                            csvRow = row;
                                            break;
                                        }
                                    }
                                }

                                if (csvRow) {
                                    const importedObject = await loadMaterialObject(modelApi, csvRow);
                                    let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
                                    if (!matchedMaterial && importedObject.materials && importedObject.materials.length) {
                                        matchedMaterial = importedObject.materials[0];
                                    }

                                    if (matchedMaterial) {
                                        const fabricArmrestObjects = objectIndex.get('fabric_armrest') || [];
                                        let appliedCount = 0;
                                        for (const obj of fabricArmrestObjects) {
                                            const id = getObjectId(obj);
                                            if (id) {
                                                try {
                                                    await modelApi.addOrEditMaterial(id, matchedMaterial);
                                                    appliedCount++;
                                                    debugLog('Applied black plastic to armrest object', id);
                                                } catch (e) {
                                                    debugLog('Failed to apply black plastic to armrest', id, e);
                                                }
                                            }
                                        }
                                        if (appliedCount > 0) {
                                            debugLog('Auto-applied Plastic Armrest to', appliedCount, 'armrest objects');
                                            currentArmrestSelection = 'Plastic Armrest';
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                debugLog('Error auto-applying armrest (non-critical):', err);
                // Don't throw - this is a non-critical operation
            }
        }

        // ============================================================================
        // INITIALIZATION
        // ============================================================================

        async function init() {
            try {
                const iframe = document.getElementById(iframeId);
                if (!iframe) {
                    throw new Error(`Iframe with id "${iframeId}" not found.`);
                }

                // Initialize Vectary API
                modelApi = await initVectaryApi(iframeId);

                // Expose globally for debugging
                window.vectaryModelApi = modelApi;

                // Load materials CSV and get objects in parallel
                const [materialsData, objects] = await Promise.all([
                    loadMaterialsCsv(materialsCsvUrl),
                    modelApi.getObjects(),
                ]);

                const objectIndex = buildObjectIndex(objects);
                debugLog('Initial objects index', objectIndex);

                // Auto-apply black plastic to plastic parts (wheels, glides, headrest back, chair back, armrest bottom)
                await applyPlasticPartsMaterial(modelApi, mapping, objectIndex, materialsData);

                // Auto-apply default fabric: Autumn (kvadrat) - 101
                await applyDefaultFabric(modelApi, mapping, objectIndex, materialsData);

                // Auto-apply default metal: black metal
                await applyDefaultMetal(modelApi, mapping, objectIndex, materialsData);

                // Auto-apply default armrest: Plastic Armrest
                await applyDefaultArmrest(modelApi, mapping, objectIndex, materialsData);

                // Bind UI handlers
                bindUiHandlers(modelApi, mapping, materialsData, objectIndex);
                debugLog('Vectary configurator initialized');
            } catch (err) {
                console.error('Failed to initialize Vectary configurator', err);
            }
        }

        // Wait for DOM and custom options to be ready
        function waitForOptions() {
            return new Promise(function(resolve) {
                // Cache selector string
                const containerSelector = '.product-options-wrapper, .fieldset, .product-options-bottom, .product-info-main';
                const optionsSelector = 'select, .swatch-option, .mageworx-swatch-option-custom';

                // Check if options container exists
                const optionsContainer = document.querySelector(containerSelector);
                if (optionsContainer) {
                    const options = optionsContainer.querySelectorAll(optionsSelector);
                    if (options.length > 0) {
                        if (debug) {
                            console.log('[Vectary] Options found, initializing...');
                        }
                        resolve();
                        return;
                    }
                }

                // Wait a bit and check again
                let attempts = 0;
                const maxAttempts = 20; // 2 seconds max wait
                const checkInterval = setInterval(function() {
                    attempts++;
                    const container = document.querySelector(containerSelector);
                    if (container) {
                        const options = container.querySelectorAll(optionsSelector);
                        if (options.length > 0) {
                            clearInterval(checkInterval);
                            if (debug) {
                                console.log('[Vectary] Options found after', attempts * 100, 'ms, initializing...');
                            }
                            resolve();
                            return;
                        }
                    }
                    if (attempts >= maxAttempts) {
                        clearInterval(checkInterval);
                        if (debug) {
                            console.warn('[Vectary] Options not found after', maxAttempts * 100, 'ms, initializing anyway...');
                        }
                        resolve();
                    }
                }, 100);
            });
        }

        // Start initialization
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                waitForOptions().then(init);
            });
        } else {
            waitForOptions().then(init);
        }
    };
}));