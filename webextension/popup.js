/* LanguageTool WebExtension 
 * Copyright (C) 2016-2017 Daniel Naber (http://www.danielnaber.de)
 * 
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301
 * USA
 */
"use strict";

let defaultServerUrl = 'https://languagetool.org/api/v2';   // keep in sync with defaultServerUrl in options.js

// chrome.google.com: see http://stackoverflow.com/questions/11613371/
// docs.google.com: Google Docs has a too complicated DOM (but its own add-on framework)
// addons.mozilla.org: see http://stackoverflow.com/questions/42147966/
let unsupportedSitesRegex = /^https?:\/\/(docs.google.com|chrome.google.com|addons.mozilla.org).*/;

let thisExtensionUrl = "https://chrome.google.com/webstore/detail/languagetool/oldceeleldhonbafppcapldpdifcinji";

let googleDocsExtension = "https://chrome.google.com/webstore/detail/languagetool/kjcoklfhicmkbfifghaecedbohbmofkm";

// see https://github.com/languagetool-org/languagetool-browser-addon/issues/70:
let unsupportedReplacementSitesRegex = /^https?:\/\/(www\.)?(facebook|medium).com.*/;

// ask the user for a review in the store if they have used this add-on at least this many times:
let minUsageForReviewRequest = 30;

var testMode = false;
var serverUrl = defaultServerUrl;
var ignoreQuotedLines = true;
var quotedLinesIgnored = false;
var motherTongue = "";
var preferredVariants = [];
var manuallySelectedLanguage = "";

function getCheckResult(markupList, metaData, callback, errorCallback) {
    const req = new XMLHttpRequest();
    req.timeout = 60 * 1000; // milliseconds
    const url = serverUrl + (serverUrl.endsWith("/") ? "check" : "/check");
    req.open('POST', url);
    req.onload = function() {
        let response = req.response;
        if (!response) {
            errorCallback(chrome.i18n.getMessage("noResponseFromServer", serverUrl), "noResponseFromServer");
            return;
        }
        if (req.status !== 200) {
            errorCallback(chrome.i18n.getMessage("noValidResponseFromServer", [serverUrl, req.response, req.status]), "noValidResponseFromServer");
            return;
        }
        callback(response);
    };
    req.onerror = function() {
        errorCallback(chrome.i18n.getMessage("networkError", serverUrl), "networkError");
    };
    req.ontimeout = function() {
        errorCallback(chrome.i18n.getMessage("timeoutError", serverUrl), "timeoutError");
    };
    let text = Markup.markupList2text(markupList);
    if (ignoreQuotedLines) {
        const textOrig = text;
        // A hack so the following replacements don't happen on messed up character positions.
        // See https://github.com/languagetool-org/languagetool-browser-addon/issues/25:
        text = text.replace(/^>.*?\n/gm, function(match) {
            return " ".repeat(match.length - 1) + "\n";
        });
        quotedLinesIgnored = text != textOrig;
    }
    let userAgent = "webextension";
    if (Tools.isFirefox()) {
        userAgent += "-firefox";
    } else if (Tools.isChrome()) {
        userAgent += "-chrome";
    } else {
        userAgent += "-unknown";
    }
    let params = 'disabledRules=WHITESPACE_RULE' +   // needed because we might replace quoted text by spaces (see issue #25) 
        '&useragent=' + userAgent;
    if (true) {  // TODO: activate 'data' mode when server supports it
        params += '&text=' + encodeURIComponent(text);
    } else {
        const json = {text: text, metaData: metaData};
        params += '&data=' + encodeURIComponent(JSON.stringify(json));
    }
    if (motherTongue) {
        params += "&motherTongue=" + motherTongue;
    }
    if (manuallySelectedLanguage) {
        params += "&language=" + manuallySelectedLanguage;
        manuallySelectedLanguage = "";
    } else {
        params += "&language=auto";
        if (preferredVariants.length > 0) {
            params += "&preferredVariants=" + preferredVariants;
        }
    }
    req.send(params);
}

// to be called only with sanitized content (DOMPurify.sanitize()):
function renderStatus(statusHtml) {
    document.getElementById('status').innerHTML = statusHtml;
}

function getShortCode(languageCode) {
    return languageCode.replace(/-.*/, "");
}

function suggestionClass(match) {
    if (isSpellingError(match)) {
        return 'hiddenSpellError';
    } else if (isSuggestion(match)) {
        return 'hiddenSuggestion';
    } else {
        return 'hiddenGrammarError';
    }
}

function isSpellingError(match) {
    const ruleId = match.rule.id;
    return ruleId.indexOf("SPELLER_RULE") >= 0 ||
           ruleId.indexOf("MORFOLOGIK_RULE") >= 0 ||
           ruleId.indexOf("HUNSPELL") >= 0
}

function isSuggestion(match) {
    const issueType = match.rule.issueType;
    return issueType === 'style' ||
           issueType === 'locale-violation' ||
           issueType === 'register'
}

function renderMatchesToHtml(resultJson, response, tabs, callback) {
    const createLinks = response.isEditableText && !response.url.match(unsupportedReplacementSitesRegex);
    const data = JSON.parse(resultJson);
    const language = DOMPurify.sanitize(data.language.name);
    const languageCode = DOMPurify.sanitize(data.language.code);
    const shortLanguageCode = getShortCode(languageCode);
    let translatedLanguage = chrome.i18n.getMessage(languageCode.replace(/-/, "_"));
    if (!translatedLanguage) {
        translatedLanguage = chrome.i18n.getMessage(shortLanguageCode);  // needed for e.g. "ru-RU"
    }
    if (!translatedLanguage) {
        translatedLanguage = language;
    }
    let html = '<a id="closeLink" href="#"></a>';
    html += DOMPurify.sanitize(getLanguageSelector(languageCode));
    html += '<div id="outerShortcutHint"></div>';
    html += "<hr>";
    let matches = data.matches;
    Tools.getStorage().get({
        dictionary: [],
        ignoredRules: []
    }, function(items) {
        let matchesCount = 0;
        // remove overlapping rules in reverse order so we match the results like they are shown on web-pages
        if (matches) {
            const uniquePositionMatches = [];
            let prevErrStart = -1;
            let prevErrLen = -1;
            for (let i = matches.length-1; i >= 0; i--) {
                const m = matches[i];
                const errStart = parseInt(m.offset);
                const errLen = parseInt(m.length);
                if (errStart != prevErrStart || errLen != prevErrLen) {
                    uniquePositionMatches.push(m);
                    prevErrStart = errStart;
                    prevErrLen = errLen;
                }
            }
            uniquePositionMatches.reverse();
            matches = uniquePositionMatches;
        }

        const ignoredRuleCounts = {};
        for (let match in matches) {
            const m = matches[match];

            // these values come from the server, make sure they are ints:
            const errStart = parseInt(m.context.offset);
            const errLen = parseInt(m.length);

            // these string values come from the server and need to be sanitized
            // as they will be inserted with innerHTML:
            const contextSanitized = DOMPurify.sanitize(m.context.text);
            const ruleIdSanitized = DOMPurify.sanitize(m.rule.id);
            const messageSanitized = DOMPurify.sanitize(m.message);
            const descriptionSanitized = DOMPurify.sanitize(m.rule.description);

            const wordSanitized = contextSanitized.substr(errStart, errLen);
            let ignoreError = false;

            if (isSpellingError(m)) {
                // Also accept uppercase versions of lowercase words in personal dict:
                const knowToDict = items.dictionary.indexOf(wordSanitized) != -1;
                if (knowToDict) {
                    ignoreError = true;
                } else if (!knowToDict && Tools.startWithUppercase(wordSanitized)) {
                    ignoreError = items.dictionary.indexOf(Tools.lowerCaseFirstChar(wordSanitized)) != -1;
                }
            } else {
                ignoreError = items.ignoredRules.find(k => k.id === ruleIdSanitized && k.language === shortLanguageCode);
            }
            if (ignoreError) {
                if (ignoredRuleCounts[ruleIdSanitized]) {
                    ignoredRuleCounts[ruleIdSanitized]++;
                } else {
                    ignoredRuleCounts[ruleIdSanitized] = 1;
                }
            } else {
                html += "<div class=\"suggestionRow " + suggestionClass(m) + "\">\n";
                if (isSpellingError(m)) {
                    const escapedWord = Tools.escapeHtml(wordSanitized);
                    html += "<div class='addToDict' data-addtodict='" + escapedWord + "'" +
                            " title='" + chrome.i18n.getMessage("addToDictionaryTitle", escapedWord).replace(/'/, "&apos;") + "'></div>";
                } else {
                    html += "<div class='turnOffRule' data-ruleIdOff='" + Tools.escapeHtml(ruleIdSanitized) + "'" +
                            " data-ruleDescription='" + Tools.escapeHtml(descriptionSanitized) + "'" +
                            " title='" + chrome.i18n.getMessage("turnOffRule").replace(/'/, "&apos;") + "'></div>";
                }
                html += Tools.escapeHtml(messageSanitized);
                html += renderContext(contextSanitized, errStart, errLen);
                html += renderReplacements(contextSanitized, m, createLinks);
                html += "</div>\n";
                html += "<hr>";
                matchesCount++;
            }
        }
        if (matchesCount == 0) {
            html += "<p>" + chrome.i18n.getMessage("noErrorsFound") + "</p>";
        }
        if (quotedLinesIgnored) {
            html += "<p class='quotedLinesIgnored'>" + chrome.i18n.getMessage("quotedLinesIgnored") + "</p>";
        }
        if (items.ignoredRules && items.ignoredRules.length > 0) {
            const ruleItems = [];
            const currentLang = getShortCode(languageCode);
            for (let key in items.ignoredRules) {
                const ignoredRule = items.ignoredRules[key];
                if (currentLang === ignoredRule.language) {
                    const ruleId = Tools.escapeHtml(ignoredRule.id);
                    let ruleDescription = Tools.escapeHtml(ignoredRule.description);
                    const matchCount = ignoredRuleCounts[ruleId];
                    if (matchCount) {
                        ruleItems.push("<span class='ignoredRule'><a class='turnOnRuleLink' data-ruleIdOn='"
                            + ruleId + "' href='#'>" + ruleDescription + " (" + matchCount + ")</a></span>");
                    }
                }
            }
            if (ruleItems.length > 0) {
                html += "<span class='ignoredRulesIntro'>" + chrome.i18n.getMessage("ignoredRules") + "</span> ";
                html += ruleItems.join(" &middot; ");
            }
        }
        html += "<p id='reviewRequest'></p>";
        if (serverUrl === defaultServerUrl) {
            html += "<p class='poweredBy'>" + chrome.i18n.getMessage("textCheckedRemotely", "https://languagetool.org") + "</p>";
        } else {
            html += "<p class='poweredBy'>" + chrome.i18n.getMessage("textCheckedBy", DOMPurify.sanitize(serverUrl)) + "</p>";
        }
        if (testMode) {
            html += "*** running in test mode ***";
        }
        renderStatus(html);
        setHintListener();
        if (matchesCount > 0) {
            fillReviewRequest(matchesCount);
        }
        addLinkListeners(response, tabs, languageCode);
        if (callback) {
            callback(response.markupList);
        }
    });
}

function setHintListener() {
    chrome.commands.getAll(function(commands) {
        Tools.getStorage().get({
            showShortcutHint: true
        }, function(items) {
            if (items.showShortcutHint) {
                showShortcutHint(commands);
            }
        });
    });
}

function fillReviewRequest() {
    const storage = Tools.getStorage();
    storage.get({
        usageCounter: 0,
        reviewRequestLinkClicked: false
    }, function(items) {
        //console.log("usageCounter: " + items.usageCounter + ", reviewRequestLinkClicked: " + items.reviewRequestLinkClicked);
        if (! items.reviewRequestLinkClicked && items.usageCounter >= minUsageForReviewRequest) {
            if (Tools.isChrome()) {
                const reviewRequestId = document.getElementById("reviewRequest");
                reviewRequestId.innerHTML = chrome.i18n.getMessage("reviewRequest", thisExtensionUrl + "/reviews");
                reviewRequestId.addEventListener("click", function() {
                    storage.set({
                        reviewRequestLinkClicked: true
                    }, function () {});
                });
            } else if (Tools.isFirefox()) {
                // TODO: activate
            }
        }
    });
}

function showShortcutHint(commands) {
    if (commands && commands.length && commands.length > 0 && commands[0].shortcut) {
        const shortcut = commands[0].shortcut;
        document.getElementById("outerShortcutHint").innerHTML =
            "<div id='shortcutHint'>" +
            chrome.i18n.getMessage("shortcutHint", ["<tt>" + shortcut + "</tt>"]) +
            "&nbsp;<a id='closeShortcutHint' href='#'>" + chrome.i18n.getMessage("shortcutHintDismiss", [shortcut]) + "</a>" +
            "</div>";
        document.getElementById("closeShortcutHint").addEventListener("click", function() {
            Tools.getStorage().set({
                showShortcutHint: false
            }, function () {
                document.getElementById("outerShortcutHint").style.display = "none";
            });
        });
    }
}

function getLanguageSelector(languageCode) {
    // It might be better to get the languages from the API (but not for every check call):
    const languages = [
        "ast-ES", "be-BY", "br-FR", "ca-ES", "ca-ES-valencia", "zh-CN", "da-DK", "nl",
        "en-US", "en-GB", "en-AU", "en-CA", "en-NZ", "en-ZA", "eo", "fr", "gl-ES",
        "de-DE", "de-AT", "de-CH", "el-GR", "is-IS", "it", "ja-JP", "km-KH", "lt-LT", "ml-IN",
        "fa", "pl-PL", "pt-PT", "pt-BR", "ro-RO", "ru-RU", "sk-SK",
        "sl-SI", "es", "sv", "tl-PH", "ta-IN", "uk-UA"
    ];
    let html = "<div id='top'>";
    html += chrome.i18n.getMessage("language");
    html += "<input type='hidden' id='prevLanguage' name='prevLanguage' value='" + Tools.escapeHtml(languageCode) + "'>";
    html += "&nbsp;<select id='language'>";
    for (let l in languages) {
        const langCode = languages[l];
        const langCodeForTrans = languages[l].replace(/-/g, "_");
        const selected = languageCode == langCode ? "selected" : "";
        let translatedLang = chrome.i18n.getMessage(langCodeForTrans);
        if (!translatedLang) {
            translatedLang = chrome.i18n.getMessage(langCodeForTrans.replace(/_.*/, ""));
        }
        if (!translatedLang) {
            translatedLang = Tools.getLangName(langCode);
        }
        html += "<option " + selected + " value='" + langCode + "'>" + translatedLang + "</option>";
    }
    html += "</select>";
    html += "</div>";
    return html;
}

// call only with sanitized context
function renderContext(contextSanitized, errStart, errLen) {
    return "<div class='errorArea'>"
          + Tools.escapeHtml(contextSanitized.substr(0, errStart))
          + "<span class='error'>" + Tools.escapeHtml(contextSanitized.substr(errStart, errLen)) + "</span>" 
          + Tools.escapeHtml(contextSanitized.substr(errStart + errLen))
          + "</div>";
}

// call only with sanitized context
function renderReplacements(contextSanitized, m, createLinks) {
    const ruleIdSanitized = DOMPurify.sanitize(m.rule.id);
    const replacements = m.replacements.map(k => k.value);
    const contextOffset = parseInt(m.context.offset);
    const errLen = parseInt(m.length);
    const errOffset = parseInt(m.offset);
    const errorTextSanitized = contextSanitized.substr(contextOffset, errLen);
    let html = "<div class='replacements'>";
    let i = 0;
    for (let idx in replacements) {
        const replacementSanitized = DOMPurify.sanitize(replacements[idx]);
        if (i >= 7) {
            // showing more suggestions usually doesn't make sense
            break;
        }
        if (i++ > 0) {
            html += "&nbsp; ";
        }
        if (createLinks) {
            html += "<a class='replacement' href='#'" +
                    " data-ruleid='" + ruleIdSanitized + "'" +
                    " data-erroroffset='" + errOffset + "'" +
                    " data-errortext='" + Tools.escapeHtml(errorTextSanitized) + "'" +
                    " data-replacement='" + Tools.escapeHtml(replacementSanitized) + "'" +
                    "'>&nbsp;" + Tools.escapeHtml(replacementSanitized) + "&nbsp;</a>";  // add &nbsp; to make small links better clickable by making them wider
        } else {
            html += "<b>" + Tools.escapeHtml(replacementSanitized) + "</b>";
        }
    }
    html += "</div>";
    return html;
}

function addLinkListeners(response, tabs, languageCode) {
    document.getElementById("language").addEventListener("change", function() {
        manuallySelectedLanguage = document.getElementById("language").value;
        const prevLanguage = document.getElementById("prevLanguage").value;
        const langSwitch = prevLanguage + " -> " + manuallySelectedLanguage;
        doCheck(tabs, "switch_language", langSwitch);
    });
    const closeLink = document.getElementById("closeLink");
    closeLink.addEventListener("click", function() {
        self.close();
    });
    addListenerActions(document.getElementsByTagName("a"), tabs, response, languageCode);
    addListenerActions(document.getElementsByTagName("div"), tabs, response, languageCode);
}

function addListenerActions(elements, tabs, response, languageCode) {
    for (let i = 0; i < elements.length; i++) {
        const link = elements[i];
        const isRelevant = link.getAttribute("data-ruleIdOn")
                      || link.getAttribute("data-ruleIdOff")
                      || link.getAttribute('data-addtodict')
                      || link.getAttribute('data-errortext');
        if (!isRelevant) {
            continue;
        }
        link.addEventListener("click", function() {
            const storage = Tools.getStorage();
            if (link.getAttribute('data-ruleIdOn')) {
                storage.get({
                    ignoredRules: []
                }, function(items) {
                    let idx = 0;
                    for (let rule of items.ignoredRules) {
                        if (rule.id == link.getAttribute('data-ruleIdOn')) {
                            items.ignoredRules.splice(idx, 1);
                            storage.set({'ignoredRules': items.ignoredRules}, function() {
                                reCheck(tabs, "turn_on_rule");
                                Tools.track(tabs[0].url, "rule_turned_on", languageCode + ":" + rule.id);
                            });
                            break;
                        }
                        idx++;
                    }
                });
                
            } else if (link.getAttribute('data-ruleIdOff')) {
                storage.get({
                    ignoredRules: []
                }, function(items) {
                    const ignoredRules = items.ignoredRules;
                    const ruleId = link.getAttribute('data-ruleIdOff');
                    ignoredRules.push({
                        id: ruleId,
                        description: link.getAttribute('data-ruleDescription'),
                        language: getShortCode(document.getElementById("language").value)
                    });
                    storage.set({'ignoredRules': ignoredRules}, function() {
                        reCheck(tabs, "turn_off_rule");
                        Tools.track(tabs[0].url, "rule_turned_off", languageCode + ":" + ruleId);
                    });
                });

            } else if (link.getAttribute('data-addtodict')) {
                storage.get({
                    dictionary: []
                }, function(items) {
                    const dictionary = items.dictionary;
                    dictionary.push(link.getAttribute('data-addtodict'));
                    storage.set({'dictionary': dictionary}, function() { reCheck(tabs, "add_to_dict") });
                });

            } else if (link.getAttribute('data-errortext')) {
                const data = {
                    action: 'applyCorrection',
                    errorOffset: parseInt(link.getAttribute('data-erroroffset')),
                    errorText: link.getAttribute('data-errortext'),
                    replacement: link.getAttribute('data-replacement'),
                    markupList: response.markupList,
                    serverUrl: serverUrl,
                    pageUrl: tabs[0].url
                };
                chrome.tabs.sendMessage(tabs[0].id, data, function(response) {
                    doCheck(tabs, "apply_suggestion");   // re-check, as applying changes might change context also for other errors
                });
            }
        });
    }
}

function reCheck(tabs, causeOfCheck) {
    chrome.tabs.sendMessage(tabs[0].id, {action: 'checkText', serverUrl: serverUrl, pageUrl: tabs[0].url}, function (response) {
        doCheck(tabs, causeOfCheck);
    });
}
    
function handleCheckResult(response, tabs, callback) {
    if (!response) {
        // not sure *why* this happens...
        renderStatus(chrome.i18n.getMessage("freshInstallReload"));
        Tools.logOnServer("freshInstallReload on " + tabs[0].url, serverUrl);
        return;
    }
    if (response.message) {
        renderStatus(Tools.escapeHtml(DOMPurify.sanitize(response.message)));
        return;
    }
    if (Markup.markupList2text(response.markupList).trim() === "") {
        let msg = chrome.i18n.getMessage("noTextFound") + "<br>" +
                  "<span class='errorMessageDetail'>" + chrome.i18n.getMessage("noTextFoundDetails") + "</span>";
        renderStatus(msg);
        Tools.track(tabs[0].url, "no_text");
        return;
    }
    getCheckResult(response.markupList, response.metaData, function(resultText) {
        renderMatchesToHtml(resultText, response, tabs, callback);
    }, function(errorMessage, errorMessageCode) {
        renderStatus(chrome.i18n.getMessage("couldNotCheckText", Tools.escapeHtml(DOMPurify.sanitize(errorMessage))));
        Tools.logOnServer("couldNotCheckText on " + tabs[0].url  + ": " + errorMessageCode, serverUrl);
        if (callback) {
            callback(response.markupList, errorMessage);
        }
    });
}

function startCheckMaybeWithWarning(tabs) {
    Tools.getStorage().get({
            apiServerUrl: serverUrl,
            ignoreQuotedLines: ignoreQuotedLines,
            motherTongue: motherTongue,
            enVariant: "en-US",
            deVariant: "de-DE",
            ptVariant: "pt-PT",
            caVariant: "ca-ES",
            allowRemoteCheck: false,
            usageCounter: 0
        }, function(items) {
            serverUrl = items.apiServerUrl;
            if (serverUrl === 'https://languagetool.org:8081/') {
                // This is migration code - users of the old version might have
                // the old URL of the v1 API in their settings, force them to use
                // the v2 JSON API, as this is what this extension supports now:
                //console.log("Replacing old serverUrl " + serverUrl + " with " + defaultServerUrl);
                // -> http://stackoverflow.com/questions/12229544/what-can-cause-a-chrome-browser-extension-to-crash
                serverUrl = defaultServerUrl;
            }
            ignoreQuotedLines = items.ignoreQuotedLines;
            motherTongue = items.motherTongue;
            if (items.enVariant) {
                preferredVariants.push(items.enVariant);
            }
            if (items.deVariant) {
                preferredVariants.push(items.deVariant);
            }
            if (items.ptVariant) {
                preferredVariants.push(items.ptVariant);
            }
            if (items.caVariant) {
                preferredVariants.push(items.caVariant);
            }
            if (items.allowRemoteCheck === true) {
                doCheck(tabs, "manually_triggered");
                const newCounter = items.usageCounter + 1;
                Tools.getStorage().set({'usageCounter': newCounter}, function() {});
                chrome.runtime.setUninstallURL("https://languagetool.org/webextension/uninstall.php");
            } else {
                let message = "<p>";
                if (serverUrl === defaultServerUrl) {
                    message += chrome.i18n.getMessage("privacyNoteForDefaultServer", ["https://languagetool.org", "https://languagetool.org/privacy/"]);
                } else {
                    message += chrome.i18n.getMessage("privacyNoteForOtherServer", serverUrl);
                }
                message += '</p>';
                message += '<ul>' +
                           '  <li><a class="privacyLink" id="confirmCheck" href="#">' + chrome.i18n.getMessage("continue") + '</a></li>' +
                           '  <li><a class="privacyLink" id="cancelCheck" href="#">' + chrome.i18n.getMessage("cancel") + '</a></li>' +
                           '</ul>';
                renderStatus(message);
                document.getElementById("confirmCheck").addEventListener("click", function() {
                    Tools.getStorage().set({
                        allowRemoteCheck: true
                    }, function () {
                        doCheck(tabs, "manually_triggered");
                        Tools.track(tabs[0].url, "accept_privacy_note");
                    });
                });
                document.getElementById("cancelCheck").addEventListener("click", function() {
                    Tools.track(tabs[0].url, "cancel_privacy_note");
                    self.close();
                });
            }
        });
}

function doCheck(tabs, causeOfCheck, optionalTrackDetails) {
    renderStatus('<img src="images/throbber_28.gif"> ' + chrome.i18n.getMessage("checkingProgress"));
    const url = tabs[0].url ? tabs[0].url : "";
    if (Tools.isChrome() && url.match(/^(https?:\/\/chrome\.google\.com\/webstore.*)/)) {
        renderStatus(chrome.i18n.getMessage("webstoreSiteNotSupported"));
        Tools.logOnServer("siteNotSupported on " + url, serverUrl);
        return;
    } else if (url.match(unsupportedSitesRegex)) {
        if (url.match(/docs\.google\.com/)) {
            renderStatus(chrome.i18n.getMessage("googleDocsNotSupported", googleDocsExtension));
            Tools.logOnServer("link to google docs extension");
            return;
        } else {
            renderStatus(chrome.i18n.getMessage("siteNotSupported"));
            Tools.logOnServer("siteNotSupported on " + url.replace(/file:.*/, "file:[...]"), serverUrl);  // don't log paths, may contain personal information
            return;
        }
    }
    Tools.track(tabs[0].url, "check_trigger:" + causeOfCheck, optionalTrackDetails);
    chrome.tabs.sendMessage(tabs[0].id, {action: 'checkText', serverUrl: serverUrl, pageUrl: tabs[0].url}, function(response) {
        handleCheckResult(response, tabs);
        Tools.getStorage().set({
            lastCheck: new Date().getTime()
        }, function() {});
    });
}

function getRandomToken() {
    const randomPool = new Uint8Array(8);
    crypto.getRandomValues(randomPool);
    let hex = '';
    for (let i = 0; i < randomPool.length; ++i) {
        hex += randomPool[i].toString(16);
    }
    return hex;
}

document.addEventListener('DOMContentLoaded', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0].url === "http://localhost/languagetool-for-chrome-tests.html") {
            testMode = true;
            runTest1(tabs, "textarea1", 1);
            // TODO: more tests here
        } else {
            testMode = false;
            startCheckMaybeWithWarning(tabs);
        }
    });
});
