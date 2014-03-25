#!/bin/bash

rm -rI firefox/locale~
mv firefox/locale firefox/locale~
mkdir firefox/locale
cp firefox/locale~/en-US.properties firefox/locale/en-US.properties

source .lgn

for lang in `ls firefox/locale~ | sed "s/\.properties\|\-DE\|en\-US//g"`; do
	curl --user $U:$P http://www.transifex.net/api/2/project/languagetool/resource/firefox-extension/translation/$lang/?file > firefox/locale/$lang.properties
done

mv firefox/locale/de.properties firefox/locale/de-DE.properties

wc -l firefox/locale/*
grep "# " firefox/locale/*
