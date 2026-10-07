(function() {
    var modules = [
        '/game/modules/runtime.js',
        (currentLanguage === 'ru' ? '/game/modules/packages/ru.js' : '/game/modules/packages/en.js'),
        '/game/modules/loader.js',
        '/game/modules/fs.js',
        '/game/modules/audio.js',
        '/game/modules/graphics.js',
        '/game/modules/events.js',
        '/game/modules/fetch.js',
        (currentLanguage === 'ru' ? '/game/modules/asm_consts/ru.js' : '/game/modules/asm_consts/en.js'),
        // '/game/modules/cheats.js',
        '/game/modules/main.js'
    ];

    if (cheatsEnabled)
        modules.push('/game/modules/cheats.js');

    if (typeof importScripts === 'function') {
        importScripts.apply(null, modules);
    } else {
        var loadNext = function(i) {
            if (i < modules.length) {
                var s = document.createElement('script');
                s.src = modules[i];
                s.async = false; // Ensure order
                s.onload = function() { loadNext(i + 1); };
                s.onerror = function() { console.error('Failed to load module: ' + modules[i]); };
                document.body.appendChild(s);
            }
        };
        loadNext(0);
    }
})();
