/**
 * This module consists of all the filesystem input output operations needed to load modules from filesystem and export
 * them back. Note that the usage of this module requires one to also include `modules` module in their scope.
 * @module io
 *
 * @requires lib
 * @requires collection
 * @requires parsers
 */

var E = "",
    DOT = ".",
    HASH = "#",

    DEFAULT_INCLUDE_PATTERN = /.+\.js$/,
    DEFAULT_EXCLUDE_PATTERN = /^$/,
    DEFAULT_DOT_FILENAME = "jslink.dot",
    DEFAULT_OUT_DESTINATION = "out/",

    fs = require("fs"),
    pathUtil = require("path"),
    walkdir = require("walkdir"),
    lib = require("./lib.js"),
    parsers = require("./parsers.js"),

    ModuleCollection = require("./collection.js"),
    writeSerializedModules; // function

// Add the directives to the Source processor
ModuleCollection.Source.addDirectives(parsers.directives);
ModuleCollection.Source.addProcessors(parsers.processors);
ModuleCollection.Source.addMacros(parsers.macros);

/**
 * Writes a 2d array of modules to a set of files with the module source contents.
 *
 * @param {Array<Array>} matrix
 * @param {string=} destination
 * @param {boolean=} overwrite
 */
writeSerializedModules = function (matrix, destination, overwrite, passthrough) {
    /**
     * @todo use stream and streamTransforms for faster operations
     */
    var createTarget, // function
        appendSource, // function
        pwdest;

    // Validate the destination directory.
    destination = lib.writeableFolder(destination, DEFAULT_OUT_DESTINATION);
    pwdest = pathUtil.relative(DOT, destination);

    if (!fs.statSync(destination).isDirectory()) {
        throw lib.format("Output destination is not a directory: \"{0}\"", destination);
    }

    // Adds the content of source file to target file.
    appendSource = function (source) {
        lib.log(function () {
            return lib.format("    - {0}", pathUtil.relative(DOT, source.path));
        }, true);

        fs.appendFileSync(this[0], passthrough ? source.raw : source.content().join(E));
    };

    // Create or empty the file name from the bunch of targets.
    createTarget = function (targetFileName) {
        var sources = this;

        // In case of verbose mode, output the list of individual modules written to the export file.
        lib.log(function () {
            return lib.format("\n  ✔︎ {0} ({1})", targetFileName, lib.plural(sources.length, "module"));
        }, true);

        targetFileName = pathUtil.join(destination, targetFileName); // append destination to file name
        lib.writeableFile(true, targetFileName, overwrite, false, true);

        sources.forEach(appendSource, [targetFileName]);
    };

    // Announce the commencement of writing output files in case verbose mode is enabled.
    lib.log(function () {
        return lib.format("\nWriting export files to ./{0}", pwdest);
    });

    matrix.forEach(function (bundle) {
        // Create and append files separately to reduce spatial complexity.
        bundle.exports.forEach(createTarget, bundle.sources);
    });
};

module.exports = {
    /**
     * This function takes in a {@link module:collection~ModuleCollection} and populates it with module dependency tree
     * as loaded from files on the filesystem.
     *
     * @param {module:collection~ModuleCollection} collection
     * @param {string} path
     * @param {boolean=} [recurse]
     * @param {RegExp=|string=} [include]
     * @param {RegExp=|string=} [exclude]
     * @returns {module:collection~ModuleCollection}
     */
    populateCollectionFromFS: function (collection, path, recurse, include, exclude) {
        // Ensure the patterns in paremeter are valid regular expression objects.
        !(include instanceof RegExp) && (include = DEFAULT_INCLUDE_PATTERN);
        !(exclude instanceof RegExp) && (exclude = DEFAULT_EXCLUDE_PATTERN);

        // Store some private values within collection for use during analysis of the collection.
        collection._statFilesTotal = collection._statFilesTotal || 0;
        collection._statFilesProcessed = collection._statFilesProcessed || 0;
        collection._statFilesError = collection._statFilesError || 0;

        // If path does not exist, it is an error
        if (!fs.existsSync(path)) {
            throw new Error(lib.format("Source path \"{0}\" does not exist or is not readable.", path));
        }

        lib.log(function () {
            return lib.format("\nReading files from: \"{0}\"", path);
        });

        // Iterate over the source directories provided the root path exists.
        walkdir.sync(path, {
            /*jshint camelcase: false */// turn off since walkdir is 3rd-party.
            no_return: true, // save memory even if one has loads!
            no_recurse: !recurse
            /*jshint camelcase: true */
        }, function (path, stat) {
            var pwdRelativePath;

            // Increment counter of total file processing.
            collection._statFilesTotal++;

            // Allow only non-hidden files to proceed.
            if (lib.isUnixHiddenPath(path) || !stat.isFile()) {
                return;
            }
            // Extract the name to apply io patterns on. The patterns will not work out if full path is passed to
            // pattern matching.
            pwdRelativePath = pathUtil.relative(DOT, path);
            if (exclude.test(pwdRelativePath) || !include.test(pwdRelativePath)) {
                return;
            }

            // We increment the error counter here and would decrement later when all goes well.
            collection._statFilesError++;
            collection.addSource(path).parse(collection);

            // Since we have reached here there wasn't any error parsing/reading the file and as such we decrement the
            // counter.
            collection._statFilesError--;
            collection._statFilesProcessed++; // increment success counter

            lib.log(function () {
                return lib.format(" - {0}", pwdRelativePath);
            });
        });

        return collection;
    },

    exportCollectionToFS: function (collection, destination, overwrite, testMode, passthrough) {
        var serialized = collection.serialize(),
            matrix = [];

        // Iterate on all set of connected module groups within the collection and create array of sourcefiles that
        // contain these modules.
        serialized.forEach(function (modules) {
            var stack = [],
                exports = [],
                added = {}, // use this to check whether a source was already pushed in stack.
                module,
                i;

            // Least likely, but module can end up having all disconnected empty subgraphs... don't know when though!
            if (!modules.length) {
                return;
            }

            i = modules.length;
            while (i--) {
                module = modules[i];
                // We would not add the same source twice and hence check the hash.
                if (added[module.source]) {
                    break;
                }
                // Add to flag even if it is not defines, so that repeated checks are not needed.
                added[module.source] = true;
                // Add the module to export stack provided its source has been defined.
                if (module.defined()) {
                    stack.unshift(module.source); // add it to stack
                    // We check if this module has any export directives and if so, add it for later.
                    module.exports && (exports = exports.concat(module.exports));
                }
            }
            matrix.push({
                sources: stack,
                exports: exports
            });
        });

        // If test mode is true, we do not need to proceed further with exporting the files
        if (!testMode) {
            writeSerializedModules(matrix, destination, overwrite, passthrough);
        }
    },

    /**
     * Processes the sources within a collection.
     *
     * @param {module:collection~ModuleCollection} collection
     * @param {object} options
     */
    processCollectionSources: function (collection, options) {
        var //processorOptions = {},
            //processor,
            option,
            macros = {},
            item;

        // for (processor in ModuleCollection.Source.processors) {
        //     processor = ModuleCollection.Source.processors[processor];
        //     option = options[processor.name];

        //     if (option) {
        //         processorOptions[processor.name] =  Array.isArray(option) ? option : (option === true ? [] :
        //              [option]);
        //     }
        // }

        // for (var source in collection.sources) {
        //     collection.sources[source].process(processorOptions);
        // }

        Object.keys(options).forEach(function (item) {
            if (item.charAt() !== HASH) {
                return;
            }

            /**
             * @todo Use better split technique to allow escaping of the separator characters
             */
            option = options[item].split(/\s*\;\s*/);
            item = item.substr(1);
            macros[item] = {};

            option.forEach(function (definition) {
                definition = definition.split(/\s*\:\s*/);
                if (macros[item][definition[0]]) {
                    throw new Error(lib.format("Duplicate macro definition of \"{0}\" for macro \"{1}\".",
                        definition[0], item));
                }
                macros[item][definition[0]] = definition[1];
            });
        });

        for (item in collection.sources) {
            collection.sources[item].macro(macros);
        }
    },

    /**
     * Export the dependency map of a collection as a graphViz `dot` file.
     *
     * @param {module:collection~ModuleCollection} collection
     * @param {string} path
     * @param {boolean=} [overwrite]
     * @returns {module:collection~ModuleCollection}
     */
    writeCollectionToDot: function (collection, path, overwrite) {
        // Get the final path to the export file.
        path = lib.writeableFile(path, DEFAULT_DOT_FILENAME, overwrite, true);

        // Ensure that the output file is not one of the input files!
        if (collection.sources[path]) {
            throw new Error("The dot output file path overwrites input files!");
        }

        // In case overwriting is disabled, we check whether the dot file already exists or not.
        if ((overwrite === false) && fs.existsSync(path)) {
            throw new Error(lib.format("Cannot overwrite \"{0}\".", path));
        }

        // Thankfully, the dot file is generated by the collection's toString method itself.
        fs.writeFileSync(path, collection.toString());
        return collection;
    }
};

/**
 * Function to add file parsing statistics to collection.
 */
ModuleCollection.analysers.push(function (stat) {
    // All the work for these stats were picked up during execution of loadFromFile function
    stat.filesTotal = this._statFilesTotal;
    stat.filesProcessed = this._statFilesProcessed;
    stat.filesIgnored = this._statFilesTotal - this._statFilesProcessed - this._statFilesError;
});
