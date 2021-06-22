import { S3 } from 'aws-sdk'
import { isRight } from 'fp-ts/Either'
import { PluginConfigCodec } from './config'
import { parse } from './state-parser'
import { fetchers } from './fetchers'
import { tfStateSchema } from './schema'
import get from 'lodash/get'

const schemaKey = 'terraformRemoteState'

export const apply = (serverless: Serverless.Instance, _options: Serverless.Options, downloaders: typeof fetchers) => async () => {
  if (!serverless.service.custom.terraformRemoteState) {
    return Promise.resolve()
  } else {
    const result = PluginConfigCodec.decode(serverless.service.custom.terraformRemoteState)
    if (isRight(result)) {
      const config = result.right
      const outputs = await Promise.all(Object.keys(config)
        .map(k => downloaders[config[k].backend](cfg => new S3({ region: cfg.config.region }))(config[k])
          .then(parse)
          .then(r => isRight(r) ? Promise.resolve(r.right) : Promise.reject(r.left))
          .then(r => ({ key: k, output: r }))))
      return groupByKey(outputs)
    } else {
      return Promise.reject(`Bad config: ${JSON.stringify(serverless.service.custom.terraformRemoteState)}. Expected { bucket, key, region}`)
    }
  }
}
const groupByKey = (inputs: {key: string, output: any}[]) : object => {
  return inputs.reduce((acc, {key, output}) =>{
    acc[key]  = {outputs: output}
    return acc
  }, {})
}

export class TerraformRemoteStatePlugin {
  hooks: { [key: string]: Function }
  pluginName: string
  configurationVariablesSources: any
  serverless: Serverless.Instance
  options: Serverless.Options
  resolvedData: {[key: string]: any}

  constructor(private serverlessI: Serverless.Instance, private opts: Serverless.Options) {
    this.serverless = serverlessI
    this.options = opts
    this.resolvedData = {}
    const hookHandler = apply(serverlessI, opts, fetchers)

    // Attach your piece of schema to main schema
    this.serverless.configSchemaHandler.defineCustomProperties(tfStateSchema)

    this.hooks = {
      'before:print:print': hookHandler,
      'after:package:initialize': hookHandler,
      'before:offline:start': hookHandler,
      'before:offline:start:init': hookHandler
    }
    const self = this
    this.configurationVariablesSources = {
       [schemaKey]: {
         async resolve({address, _params, _resolveConfigurationProperty, _options}) {
          self.resolvedData = await hookHandler() || []
          return {
            value: get(self.resolvedData, address, null)
          }
         },
       }
     }

    this.pluginName = 'serverless-plugin-terraform-remote-state'
  }
}
