module S3 {

    var s3Bucket = "";
    var s3FilePrefix = "";

    function nsResolver(prefix) {
        switch (prefix) {
            case 'xhtml':
                return 'http://www.w3.org/1999/xhtml';
            case 's3':
                return 'http://s3.amazonaws.com/doc/2006-03-01/';
            default:
                return null;
        }
    }

    export function configure(config) {
        if (config.s3Bucket) {
            s3Bucket = config.s3Bucket;
        }
        if (config.s3FilePrefix) {
            s3FilePrefix = config.s3FilePrefix;
        }
    }

    export function injectUpload(element) {
        var upload = new S3Upload(element);
        return {
            /**
             * Upload all the attached file
             * @return Q.promise[]
             */
            submit: function() {
                return upload.submit();
            }
        }
    }

    class MultipartUpload {
        filePart: MultiPartIterator;
        xhr: XMLHttpRequest;
        constructor(filePart: MultiPartIterator) {
            this.xhr = new XMLHttpRequest();
            this.filePart = filePart;
        }
        getSignature(method, type, date, headers, resource, md5="") {
            var deferred = Q.defer();
            if (headers.length > 0) {
                headers += "\n";
            }
            headers += 'x-amz-date:'+date;
            console.log(method+':'+md5+':'+type+':'+headers+':'+resource);
            Ext.Ajax.request({
                url: 'genSignature.php',
                method: 'POST',
                scope: this,
                params: {
                    verb: method,
                    md5: md5,
                    type: type,
                    headers: headers,
                    resource: '/'+s3Bucket+resource
                },
                success: function(response, opts) {
                    deferred.resolve(Ext.util.JSON.decode(response.responseText));
                },
                failure: function(response, opts) {
                    deferred.reject(Ext.util.JSON.decode(response.responseText));
                }
            });
            return deferred.promise;
        }
        initiate() {
            var deferred = Q.defer();
            var date = new Date();
            var resource = '/'+s3FilePrefix+this.filePart.getFileName()+"?uploads";
            var me = this;
            this.getSignature('POST', this.filePart.getType(), date.toUTCString(), '', resource)
                .then(function(response) {
                    me.xhr.open('POST', '//'+s3Bucket+".s3.amazonaws.com"+resource, true);
                    me.xhr.setRequestHeader("Content-Type", me.filePart.getType());
                    me.xhr.setRequestHeader("Authorization", response.auth);
                    me.xhr.setRequestHeader("x-amz-date", date.toUTCString());
                    me.xhr.onload = function(e) {
                        var parser = new DOMParser();
                        var responseDoc = this.responseXML;
                        if (this.status == 200) {
                            console.log(responseDoc);
                            deferred.resolve(responseDoc.evaluate('//s3:UploadId', responseDoc, nsResolver, XPathResult.STRING_TYPE, null).stringValue);
                        } else {
                            deferred.reject(new Error());
                        }
                    };
                    me.xhr.send();
                });
            return deferred.promise;
        }
        upload(uploadId) {
            var deferred = Q.defer();
            var date = new Date();
            var resource = '/'+s3FilePrefix+this.filePart.getFileName()+'?partNumber='+(this.filePart.getPartNumber()+1)+'&uploadId='+uploadId;
            var me = this;
            this.getSignature('PUT', this.filePart.getType(), date.toUTCString(), '', resource)
                .then(function (response) {
                    me.xhr.open('PUT', '//'+s3Bucket+".s3.amazonaws.com"+resource, true);
                    me.xhr.setRequestHeader("Content-Type", me.filePart.getType());
                    me.xhr.setRequestHeader("x-amz-date", date.toUTCString());
                    me.xhr.setRequestHeader("Authorization", response.auth);
                    me.xhr.onload = function(e) {
                        if (this.status == 200) {
                            deferred.resolve();
                        } else {
                            deferred.reject(new Error());
                        }
                    };
                    me.xhr.send(me.filePart.getBlob());
                });
            return deferred.promise;
        }
        done(uploadId) {
            /** todo */
        }
    }

    class S3Upload {
        private uploadElement: Ext.Element;
        private minMultipartSize: number;
        private fileList: MultiPartIterator[];
        constructor(element: string) {
            this.uploadElement = Ext.get(element);
            this.uploadElement.addListener("change", this.attachFile, this);
            this.minMultipartSize = 1025 * 1025 * 5;
            this.fileList = [];
        }

        private attachFile() {
            this.fileList = [];
            Ext.each(this.uploadElement.dom.files, function(file) {
                this.fileList.push(this.getFileMultiPart(file));
            }, this);
        }

        /**
         * Get MultiPart of the file.
         * @param file
         * @returns {MultiPartIterator}
         */
        getFileMultiPart(file: File) {
            if (file.size > this.minMultipartSize * 10000) {
                var sizePerPart = Math.ceil(file.size / 10000);
                return new MultiPartIterator(file, sizePerPart);
            } else {
                return new MultiPartIterator(file, this.minMultipartSize);
            }
        }

        submit() {
            var promiseList = [];
            Ext.each(this.fileList, function(filePart) {
                var deferred = Q.defer();
                var upload = new MultipartUpload(filePart);
                upload.initiate().then(function(id) {
                    var nextPart = function() {
                        if (filePart.next()) {
                            upload.upload(id).then(function() {
                                nextPart();
                            }, function() {
                                deferred.reject();
                            });
                        } else {
                            upload.done(id).then(function() {
                                deferred.resolve();
                            }, function() {
                                deferred.reject();
                            });
                        }
                    };
                    nextPart();
                }, function() {
                    deferred.reject();
                });
                promiseList.push(deferred.promise);
            });
            return promiseList;
        }
    }

    class MultiPartIterator {
        private file: File;
        private partSize: number;
        private current: number;
        private partNumber: number;
        constructor(file: File, partSize: number) {
            this.file = file;
            this.partSize = partSize;
            this.partNumber  = Math.ceil(file.size / partSize);
            this.current = -1;
        }

        /**
         * Get the File blob in part
         *
         * @returns {Blob}
         */
        getBlob() {
            if (this.current < 0) this.current = 0;
            if (this.current == this.partNumber) {
                return this.file.slice(this.current * this.partSize, this.file.size, this.file.type);
            }
            return this.file.slice(this.current * this.partSize, (this.current+1)*this.partSize, this.file.type);
        }

        getPartNumber() {
            return this.current;
        }

        getFileName() {
            return this.file.name;
        }

        getType() {
            return this.file.type;
        }

        /**
         * Next part in the sequence
         *
         * @returns {boolean}
         */
        next() {
            if (this.current >= this.partNumber) {
                return false;
            }
            this.current++;
            return true;
        }

        /**
         * Start from the beginning again
         */
        reset() {
            this.current = -1;
        }
    }
}